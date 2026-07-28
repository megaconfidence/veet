const localVid = document.getElementById('local-video');
const remoteVid = document.getElementById('remote-video');
const videoBtn = document.getElementById('video-ctl');
const endCallBtn = document.getElementById('endcall');
const audioBtn = document.getElementById('audio-ctl');

// Signalling runs on the same Worker that served this page, so the origin is
// whatever we were loaded from — no environment switching needed.
const wsUrl = (id) => `${location.protocol == 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${id}`;

// Resolved before signalling starts, so peer connections can be built
// synchronously. The Worker mints short-lived TURN credentials.
let iceConfig;

let ws;
let localStream;
let remoteStream;
let peerConnection;

async function handleMessages(e) {
	const msg = JSON.parse(e.data);
	console.log(msg);
	switch (msg.type) {
		case 'joined':
			await makeCall();
			break;
		case 'candidate':
			await acceptCandidate(msg.candidate);
			break;
		case 'offer':
			await answerCall(msg.offer);
			break;
		case 'answer':
			await startCall(msg.answer);
			break;
		case 'left':
			endCall();
			break;
		default:
			break;
	}
}

const wssend = (data) => ws.send(JSON.stringify(data));

(async function () {
	const id = new URLSearchParams(location.search).get('i');
	if (!id) return;
	iceConfig = await fetch('/ice').then((r) => r.json());
	ws = new WebSocket(wsUrl(id));
	ws.onmessage = handleMessages;
	ws.onopen = () => wssend({ type: 'joined' });
	await startLocalPlayback();
})();

async function startLocalPlayback() {
	const config = { video: { width: { min: 1280, ideal: 1920 }, height: { min: 720, ideal: 1080 } }, audio: true };
	localStream = await navigator.mediaDevices.getUserMedia(config);
	localVid.srcObject = localStream;
}

async function connectToPeer() {
	peerConnection = new RTCPeerConnection(iceConfig);
	remoteStream = new MediaStream();

	localVid.classList.add('video-player-secondary');
	remoteVid.srcObject = remoteStream;
	remoteVid.classList.remove('hide');

	if (!localStream) await startLocalPlayback();

	//send local video
	localStream.getTracks().forEach((t) => {
		peerConnection.addTrack(t, localStream);
	});

	//receive & display remote video
	peerConnection.ontrack = (e) => {
		e.streams[0].getTracks().forEach((t) => {
			remoteStream.addTrack(t);
		});
	};

	peerConnection.onicecandidate = (e) => {
		if (e.candidate) {
			wssend({ type: 'candidate', candidate: e.candidate });
		}
	};
}

async function makeCall() {
	await connectToPeer();
	const offer = await peerConnection.createOffer();
	await peerConnection.setLocalDescription(offer);
	wssend({ type: 'offer', offer });
}

async function acceptCandidate(c) {
	try {
		await peerConnection.addIceCandidate(c);
	} catch (e) {
		console.log('Error adding ice candidate', e);
	}
}

async function answerCall(offer) {
	await connectToPeer();
	await peerConnection.setRemoteDescription(offer);
	const answer = await peerConnection.createAnswer();
	await peerConnection.setLocalDescription(answer);
	wssend({ type: 'answer', answer });
}

async function startCall(answer) {
	await peerConnection.setRemoteDescription(answer);
}

function endCall() {
	peerConnection.close();
	remoteVid.classList.add('hide');
	localVid.classList.remove('video-player-secondary');
}

videoBtn.addEventListener('click', () => toggleTrack('video'));
audioBtn.addEventListener('click', () => toggleTrack('audio'));
endCallBtn.addEventListener('click', () => (location.href = '/'));

function toggleTrack(kind) {
	const track = localStream.getTracks().find((t) => t.kind === kind);
	track.enabled = !track.enabled;
	document.querySelector(`#${kind}-ctl img`).src = `../images/${kind}${!track.enabled ? '_off' : ''}.svg`;
}
