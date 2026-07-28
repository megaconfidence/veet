// Device settings dialog, shared by the lobby and the call page.
//
// The host decides how a chosen device is applied. In a call that means swapping
// tracks on every peer connection; on the lobby there is nothing live yet, so the
// dialog just reopens its own preview stream.

import { canChooseOutput, listDevices, loadPrefs, onDeviceChange, openStream, routeOutput, savePrefs } from './devices.js';
import { cleanName, loadName, NAME_MAX, saveName } from './profile.js';

const FIELDS = [
	['audioinput', 'Microphone'],
	['videoinput', 'Camera'],
	['audiooutput', 'Speaker'],
];

export function createSettings(host = {}) {
	const dialog = document.createElement('dialog');
	dialog.className = 'sx';
	dialog.innerHTML = `
		<div class="sx-panel">
			<header class="sx-head">
				<h2 class="sx-title">Settings</h2>
				<button class="sx-close" type="button" aria-label="Close settings"></button>
			</header>
			<div class="sx-preview">
				<video class="sx-video" autoplay playsinline muted></video>
				<div class="sx-meter" role="img" aria-label="Microphone level"><span class="sx-meter-fill"></span></div>
			</div>
			<p class="sx-error" hidden></p>
			<label class="sx-field">
				<span class="sx-label">Your name</span>
				<input class="sx-input" type="text" maxlength="${NAME_MAX}" placeholder="Guest" autocomplete="name" spellcheck="false" />
			</label>
			${FIELDS.map(
				([kind, label]) => `
				<label class="sx-field" data-for="${kind}">
					<span class="sx-label">${label}</span>
					<select class="sx-select" data-kind="${kind}"></select>
				</label>`,
			).join('')}
			<p class="sx-note" data-note="output" hidden>Your browser always uses the system audio output.</p>
		</div>`;
	document.body.append(dialog);

	const video = dialog.querySelector('.sx-video');
	const meterFill = dialog.querySelector('.sx-meter-fill');
	const errorEl = dialog.querySelector('.sx-error');
	const nameInput = dialog.querySelector('.sx-input');
	const selects = new Map([...dialog.querySelectorAll('.sx-select')].map((s) => [s.dataset.kind, s]));

	if (!canChooseOutput) {
		dialog.querySelector('[data-for="audiooutput"]').hidden = true;
		dialog.querySelector('[data-note="output"]').hidden = false;
	}

	// A stream the dialog owns, used only when the host has nothing live.
	let ownStream = null;
	let audioCtx;
	let raf;
	let stopWatching;

	const activeStream = () => host.liveStream?.() || ownStream;

	function fail(message) {
		errorEl.textContent = message;
		errorEl.hidden = !message;
	}

	/* ------------------------------------------------------------ meter -- */

	function stopMeter() {
		cancelAnimationFrame(raf);
		audioCtx?.close().catch(() => {});
		audioCtx = undefined;
		meterFill.style.transform = 'scaleX(0)';
	}

	function startMeter(stream) {
		stopMeter();
		const track = stream?.getAudioTracks()[0];
		if (!track) return;

		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return;

		audioCtx = new Ctx();
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 512;
		audioCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);

		const data = new Uint8Array(analyser.frequencyBinCount);
		let smoothed = 0;
		const tick = () => {
			analyser.getByteTimeDomainData(data);
			let peak = 0;
			for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
			// Ease the needle so it reads as a level, not a strobe.
			smoothed = Math.max(peak / 64, smoothed * 0.86);
			meterFill.style.transform = `scaleX(${Math.min(1, smoothed).toFixed(3)})`;
			raf = requestAnimationFrame(tick);
		};
		tick();
	}

	/* ----------------------------------------------------------- render -- */

	function bindPreview() {
		const stream = activeStream();
		video.srcObject = stream || null;
		startMeter(stream);
	}

	async function refresh() {
		const devices = await listDevices();
		const prefs = loadPrefs();
		const stream = activeStream();

		// Prefer what the live tracks actually resolved to over what we asked for.
		const settled = {
			audioinput: stream?.getAudioTracks()[0]?.getSettings?.().deviceId,
			videoinput: stream?.getVideoTracks()[0]?.getSettings?.().deviceId,
		};

		for (const [kind, select] of selects) {
			const options = devices[kind] || [];
			const field = dialog.querySelector(`[data-for="${kind}"]`);
			if (field && kind != 'audiooutput') field.hidden = options.length == 0;

			const current = settled[kind] || prefs[kind] || options[0]?.deviceId || '';
			select.replaceChildren(
				...options.map((d) => {
					const option = document.createElement('option');
					option.value = d.deviceId;
					option.textContent = d.label; //device labels are user data, never HTML
					return option;
				}),
			);
			select.value = options.some((d) => d.deviceId == current) ? current : (options[0]?.deviceId ?? '');
			select.disabled = options.length == 0;
		}
	}

	/* ---------------------------------------------------------- changing -- */

	async function choose(kind, deviceId) {
		savePrefs({ [kind]: deviceId });
		fail('');

		try {
			if (kind == 'audiooutput') {
				await host.applyOutput?.(deviceId);
				await routeOutput(video, deviceId);
				return;
			}

			const track = kind == 'audioinput' ? 'audio' : 'video';
			if (host.applyInput) {
				await host.applyInput(track, deviceId);
			} else {
				// Lobby: no call to patch, so just restart the preview.
				ownStream?.getTracks().forEach((t) => t.stop());
				ownStream = await openStream();
			}
			bindPreview();
		} catch (e) {
			fail(e.name == 'NotReadableError' ? 'That device is in use by another app.' : 'Could not switch to that device.');
			await refresh();
		}
	}

	for (const [kind, select] of selects) {
		select.addEventListener('change', () => choose(kind, select.value));
	}

	/* -------------------------------------------------------------- name -- */

	let nameTimer;
	function commitName() {
		clearTimeout(nameTimer);
		// Store first: an optional call skips evaluating its arguments entirely,
		// so saving inside host.applyName?.(...) would never run on the lobby.
		const name = saveName(nameInput.value);
		host.applyName?.(name);
	}

	// Persist as they type, but hold off announcing to peers until they pause.
	nameInput.addEventListener('input', () => {
		clearTimeout(nameTimer);
		nameTimer = setTimeout(commitName, 400);
	});
	nameInput.addEventListener('change', commitName);
	nameInput.addEventListener('keydown', (e) => {
		if (e.key != 'Enter') return;
		e.preventDefault();
		commitName();
		close();
	});

	/* ------------------------------------------------------------- open -- */

	async function open() {
		dialog.showModal();
		fail('');
		nameInput.value = loadName();

		try {
			// Opening a stream is also what unlocks device *labels*, so it has to
			// happen before the first enumerate.
			if (!host.liveStream?.()) ownStream = await openStream();
			bindPreview();
		} catch {
			fail('Veet needs camera and microphone access to list your devices.');
		}

		await refresh();
		await routeOutput(video, loadPrefs().audiooutput);
		stopWatching = onDeviceChange(refresh);
	}

	function close() {
		if (dialog.open && cleanName(nameInput.value) != loadName()) commitName();
		clearTimeout(nameTimer);
		stopWatching?.();
		stopWatching = undefined;
		stopMeter();
		video.srcObject = null;
		ownStream?.getTracks().forEach((t) => t.stop());
		ownStream = null;
		if (dialog.open) dialog.close();
	}

	dialog.querySelector('.sx-close').addEventListener('click', close);
	dialog.addEventListener('close', close);
	dialog.addEventListener('click', (e) => {
		if (e.target == dialog) close(); //backdrop
	});

	return { open, close, dialog };
}
