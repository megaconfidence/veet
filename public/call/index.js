import { loadPrefs, openStream, openTrack, routeOutput, savePrefs, videoQuality } from '../shared/devices.js';
import { cleanName, loadName } from '../shared/profile.js';
import { createSettings } from '../shared/settings.js';
import { CHAT_MAX, createChat } from './chat.js';

const stage = document.getElementById('stage');
const tileTpl = document.getElementById('tile-template');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const toastEl = document.getElementById('toast');
const copyLabel = document.getElementById('copy-label');
const audioBtn = document.getElementById('audio-ctl');
const videoBtn = document.getElementById('video-ctl');
const endCallBtn = document.getElementById('endcall');

// Signalling runs on the same Worker that served this page, so the origin is
// whatever we were loaded from — no environment switching needed.
const wsUrl = (id) => `${location.protocol == 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${id}`;

// Resolved before signalling starts, so peer connections can be built
// synchronously. The Worker mints short-lived TURN credentials.
let iceConfig;

let ws;
let myId;
let localStream;
let guestCount = 0;
let myName = loadName();

// One RTCPeerConnection per remote participant — a full mesh.
const peers = new Map();

const signal = (data) => ws?.readyState == WebSocket.OPEN && ws.send(JSON.stringify(data));

// Built up front so an early data channel always has somewhere to render.
const chat = createChat({ onSend: sendChat });

/* ---------------------------------------------------------------- tiles -- */

function addTile(id, { self = false } = {}) {
	const tile = tileTpl.content.firstElementChild.cloneNode(true);
	tile.dataset.peer = id;
	if (self) tile.classList.add('tile-self');

	const video = tile.querySelector('.tile-video');
	video.muted = self; //never play our own audio back
	stage.append(tile);
	relayout();
	return tile;
}

const tileOf = (id) => stage.querySelector(`.tile[data-peer="${CSS.escape(id)}"]`);

// Peers who never introduce themselves keep the "Guest n" they were assigned.
function setTileName(id, name) {
	const chosen = cleanName(name); //never trust a name off the wire
	const entry = peers.get(id);
	if (entry) entry.name = chosen; //chat labels read this too

	const tile = tileOf(id);
	if (!tile) return;

	const label = id == 'self' ? (chosen ? `${chosen} (You)` : 'You') : chosen || entry?.fallback || 'Guest';

	tile.querySelector('.tile-name').textContent = label;
	tile.querySelector('.tile-initial').textContent = label.slice(0, 1).toUpperCase();
}

function removeTile(id) {
	tileOf(id)?.remove();
	relayout();
}

// Square-ish gallery: 1→1 col, 2-4→2, 5-9→3. Two participants get the
// familiar picture-in-picture treatment instead of a split grid.
function relayout() {
	const count = stage.querySelectorAll('.tile').length;
	stage.dataset.count = count;
	stage.dataset.layout = count <= 1 ? 'solo' : count == 2 ? 'pair' : 'grid';
	stage.style.setProperty('--cols', Math.ceil(Math.sqrt(count)));
}

function setTileMuted(id, muted) {
	const badge = tileOf(id)?.querySelector('.tile-badge');
	if (badge) badge.hidden = !muted;
}

function setTileCameraOff(id, off) {
	tileOf(id)?.classList.toggle('camera-off', off);
}

function setStatus(state, text) {
	statusEl.dataset.state = state;
	statusText.textContent = text;
}

let toastTimer;
function toast(message) {
	toastEl.textContent = message;
	toastEl.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function describeRoom() {
	const others = peers.size;
	if (!others) return setStatus('waiting', 'Waiting for others');
	setStatus('live', `${others + 1} in call`);
}

/* ----------------------------------------------------------------- mesh -- */

function getPeer(id) {
	if (peers.has(id)) return peers.get(id);

	const pc = new RTCPeerConnection(iceConfig);
	const remoteStream = new MediaStream();
	guestCount += 1;
	const entry = { pc, remoteStream, pending: [], fallback: `Guest ${guestCount}`, name: '', chat: null };
	peers.set(id, entry);

	// The dialer opens the chat channel; we are the answering side here.
	pc.ondatachannel = (e) => bindChat(id, e.channel);

	const tile = addTile(id);
	setTileName(id, '');
	const video = tile.querySelector('.tile-video');
	video.srcObject = remoteStream;
	routeOutput(video, loadPrefs().audiooutput);

	localStream?.getTracks().forEach((t) => pc.addTrack(t, localStream));

	pc.ontrack = (e) => e.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));

	pc.onicecandidate = (e) => {
		if (e.candidate) signal({ type: 'candidate', to: id, candidate: e.candidate });
	};

	pc.onconnectionstatechange = () => {
		if (pc.connectionState == 'failed' || pc.connectionState == 'closed') dropPeer(id);
	};

	describeRoom();
	return entry;
}

function dropPeer(id) {
	const entry = peers.get(id);
	if (!entry) return;
	entry.chat?.close();
	entry.pc.close();
	peers.delete(id);
	removeTile(id);
	chat.append({ text: `${entry.name || entry.fallback} left the call`, system: true });
	describeRoom();
}

// Newcomers dial everyone already in the room. Existing peers only ever answer,
// so two participants can never offer to each other at the same time.
async function dial(id) {
	const { pc } = getPeer(id);

	// Created *before* the offer so the data channel rides along in the first
	// SDP. Adding one later would force a renegotiation.
	bindChat(id, pc.createDataChannel('chat', { ordered: true }));

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	signal({ type: 'offer', to: id, offer });
	introduce(id);
}

async function onOffer(id, offer) {
	const entry = getPeer(id);
	await entry.pc.setRemoteDescription(offer);
	await flushCandidates(entry);
	const answer = await entry.pc.createAnswer();
	await entry.pc.setLocalDescription(answer);
	signal({ type: 'answer', to: id, answer });
	introduce(id);
}

async function onAnswer(id, answer) {
	const entry = peers.get(id);
	if (!entry) return;
	await entry.pc.setRemoteDescription(answer);
	await flushCandidates(entry);
}

// Candidates routinely arrive before the remote description is set; holding
// them until then avoids the InvalidStateError churn.
async function onCandidate(id, candidate) {
	const entry = peers.get(id);
	if (!entry) return;
	if (!entry.pc.remoteDescription) return entry.pending.push(candidate);
	try {
		await entry.pc.addIceCandidate(candidate);
	} catch (e) {
		console.warn('Discarded ICE candidate', e);
	}
}

async function flushCandidates(entry) {
	const queued = entry.pending.splice(0);
	for (const c of queued) {
		try {
			await entry.pc.addIceCandidate(c);
		} catch (e) {
			console.warn('Discarded ICE candidate', e);
		}
	}
}

/* ------------------------------------------------------------ signalling -- */

async function handleMessages(e) {
	const msg = JSON.parse(e.data);
	switch (msg.type) {
		case 'ready':
			myId = msg.id;
			await Promise.all(msg.peers.map(dial));
			describeRoom();
			break;
		case 'joined':
			break; //they dial us; nothing to do until their offer lands
		case 'offer':
			await onOffer(msg.from, msg.offer);
			break;
		case 'answer':
			await onAnswer(msg.from, msg.answer);
			break;
		case 'candidate':
			await onCandidate(msg.from, msg.candidate);
			break;
		case 'media':
			if (msg.kind == 'audio') setTileMuted(msg.from, !msg.enabled);
			else setTileCameraOff(msg.from, !msg.enabled);
			break;
		case 'name':
			setTileName(msg.from, msg.name);
			break;
		case 'left':
			dropPeer(msg.from);
			break;
	}
}

// Let peers render our mute/camera state. Sent to one peer on connect, and to
// everyone when we toggle.
function announceMedia(to) {
	if (!localStream) return;
	for (const kind of ['audio', 'video']) {
		const track = localStream.getTracks().find((t) => t.kind == kind);
		if (track) signal({ type: 'media', kind, enabled: track.enabled, ...(to ? { to } : {}) });
	}
}

function announceName(to) {
	signal({ type: 'name', name: myName, ...(to ? { to } : {}) });
}

// Everything a peer needs to label and lay us out, sent as soon as we are wired
// up to them.
function introduce(to) {
	announceMedia(to);
	announceName(to);
}

/* ------------------------------------------------------------------ chat -- */

// Chat rides a WebRTC data channel, not the signalling socket, so messages go
// straight to the other browsers and never reach Cloudflare. Nothing is stored:
// leave the call and the history is gone.
function bindChat(id, channel) {
	const entry = peers.get(id);
	if (!entry) return;
	entry.chat = channel;

	channel.onmessage = (e) => {
		let text;
		try {
			text = JSON.parse(e.data).text;
		} catch {
			return; //not ours
		}
		if (typeof text != 'string' || !text.trim()) return;
		chat.append({ name: entry.name || entry.fallback, text: text.slice(0, CHAT_MAX) });
	};
}

function sendChat(text) {
	if (!peers.size) return toast('No one else is here yet');

	const payload = JSON.stringify({ text });
	let delivered = 0;
	for (const { chat: channel } of peers.values()) {
		if (channel?.readyState != 'open') continue;
		try {
			channel.send(payload);
			delivered += 1;
		} catch {
			//channel died between the check and the send
		}
	}

	chat.append({ name: 'You', text, mine: true });
	if (!delivered) toast('Still connecting — message not delivered');
	else if (delivered < peers.size) toast(`Delivered to ${delivered} of ${peers.size}`);
}

/* ----------------------------------------------------------------- boot -- */

(async function () {
	const id = new URLSearchParams(location.search).get('i');
	if (!id) return void (location.href = '/');

	addTile('self', { self: true });
	setTileName('self', myName);
	await startLocalPlayback();

	iceConfig = await fetch('/ice').then((r) => r.json());

	ws = new WebSocket(wsUrl(id));
	ws.onmessage = handleMessages;
	ws.onopen = () => describeRoom();
	ws.onclose = () => setStatus('offline', 'Disconnected');
	ws.onerror = () => setStatus('offline', 'Connection error');
})();

async function startLocalPlayback() {
	try {
		localStream = await openStream();
	} catch {
		setStatus('offline', 'Camera blocked');
		toast('Veet needs camera and microphone access');
		return;
	}
	localStream.getTracks().forEach(watchTrack);
	stage.querySelector('.tile-self .tile-video').srcObject = localStream;
}

/* --------------------------------------------------------------- devices -- */

const deviceNoun = (kind) => (kind == 'audio' ? 'microphone' : 'camera');

// Put a freshly opened track on the air: keep the mute state of the track it
// replaces, then hand it to every peer. replaceTrack swaps the outgoing media
// without touching the SDP, so nobody has to renegotiate.
async function adoptTrack(kind, track) {
	const current = localStream?.getTracks().find((t) => t.kind == kind);
	if (current) {
		track.enabled = current.enabled;
		localStream.removeTrack(current);
		current.stop();
	}

	localStream ??= new MediaStream();
	localStream.addTrack(track);
	watchTrack(track);

	await Promise.all(
		[...peers.values()].map(({ pc }) =>
			pc
				.getSenders()
				.find((s) => s.track?.kind == kind)
				?.replaceTrack(track),
		),
	);

	stage.querySelector('.tile-self .tile-video').srcObject = localStream;
}

async function swapInput(kind, deviceId) {
	await adoptTrack(kind, await openTrack(kind, deviceId));
}

async function routeAllOutput(deviceId) {
	await Promise.all([...stage.querySelectorAll('.tile-video')].map((v) => routeOutput(v, deviceId)));
}

// A track ends on its own when its device is unplugged. Forget the preference
// that pointed at it and grab whatever is still attached.
function watchTrack(track) {
	track.addEventListener('ended', async () => {
		savePrefs({ [track.kind == 'audio' ? 'audioinput' : 'videoinput']: null });
		try {
			const config = track.kind == 'audio' ? { audio: true } : { video: videoQuality };
			const [fresh] = (await navigator.mediaDevices.getUserMedia(config)).getTracks();
			await adoptTrack(track.kind, fresh);
			toast(`Switched to another ${deviceNoun(track.kind)}`);
		} catch {
			toast(`Your ${deviceNoun(track.kind)} was disconnected`);
		}
	});
}

const settings = createSettings({
	liveStream: () => localStream,
	applyInput: swapInput,
	applyOutput: routeAllOutput,
	applyName: (name) => {
		myName = name;
		setTileName('self', name);
		announceName();
	},
});

/* -------------------------------------------------------------- controls -- */

function toggleTrack(kind, button) {
	const track = localStream?.getTracks().find((t) => t.kind === kind);
	if (!track) return;

	track.enabled = !track.enabled;
	button.classList.toggle('off', !track.enabled);
	button.setAttribute('aria-pressed', String(!track.enabled));

	if (kind == 'audio') setTileMuted('self', !track.enabled);
	else setTileCameraOff('self', !track.enabled);

	signal({ type: 'media', kind, enabled: track.enabled });
}

async function copyLink() {
	try {
		await navigator.clipboard.writeText(location.href);
		toast('Meeting link copied');
		if (copyLabel) {
			copyLabel.textContent = 'Link copied';
			setTimeout(() => (copyLabel.textContent = 'Copy meeting link'), 2000);
		}
	} catch {
		toast(location.href);
	}
}

function leave() {
	peers.forEach((entry) => {
		entry.chat?.close();
		entry.pc.close();
	});
	peers.clear();
	localStream?.getTracks().forEach((t) => t.stop());
	ws?.close();
	location.href = '/';
}

audioBtn.addEventListener('click', () => toggleTrack('audio', audioBtn));
videoBtn.addEventListener('click', () => toggleTrack('video', videoBtn));
endCallBtn.addEventListener('click', leave);
document.getElementById('settings-ctl').addEventListener('click', () => settings.open());
document.getElementById('copy-link').addEventListener('click', copyLink);
document.getElementById('share-ctl').addEventListener('click', copyLink);
