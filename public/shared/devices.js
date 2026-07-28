// Device enumeration, persisted preferences, and stream acquisition.
// Shared by the lobby and the call page.

const STORAGE_KEY = 'veet.devices';

const KIND_FALLBACK = {
	audioinput: 'Microphone',
	videoinput: 'Camera',
	audiooutput: 'Speaker',
};

// Firefox and Safari cannot route audio to a chosen output device.
export const canChooseOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export function loadPrefs() {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
	} catch {
		return {}; //private mode, or someone put junk in storage
	}
}

export function savePrefs(patch) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
	} catch {
		//not fatal: the choice still applies for this session
	}
}

// Labels are empty until the user has granted permission at least once.
export async function listDevices() {
	if (!navigator.mediaDevices?.enumerateDevices) return { audioinput: [], videoinput: [], audiooutput: [] };

	const all = await navigator.mediaDevices.enumerateDevices();
	const of = (kind) =>
		all
			.filter((d) => d.kind == kind && d.deviceId)
			.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${KIND_FALLBACK[kind]} ${i + 1}` }));

	return { audioinput: of('audioinput'), videoinput: of('videoinput'), audiooutput: of('audiooutput') };
}

export const videoQuality = { width: { min: 1280, ideal: 1920 }, height: { min: 720, ideal: 1080 } };

export function constraintsFor({ audioinput, videoinput } = loadPrefs()) {
	return {
		audio: audioinput ? { deviceId: { exact: audioinput } } : true,
		video: videoinput ? { ...videoQuality, deviceId: { exact: videoinput } } : videoQuality,
	};
}

// A remembered device may be unplugged by the time we come back to it, so fall
// back to the system default rather than failing the whole call.
export async function openStream(prefs = loadPrefs()) {
	try {
		return await navigator.mediaDevices.getUserMedia(constraintsFor(prefs));
	} catch (e) {
		if (e.name != 'OverconstrainedError' && e.name != 'NotFoundError') throw e;
		savePrefs({ audioinput: null, videoinput: null });
		return navigator.mediaDevices.getUserMedia(constraintsFor({}));
	}
}

export async function openTrack(kind, deviceId) {
	const constraints =
		kind == 'audio' ? { audio: { deviceId: { exact: deviceId } } } : { video: { ...videoQuality, deviceId: { exact: deviceId } } };
	const stream = await navigator.mediaDevices.getUserMedia(constraints);
	return stream.getTracks()[0];
}

export async function routeOutput(el, deviceId) {
	if (!canChooseOutput || !deviceId || !el) return;
	try {
		await el.setSinkId(deviceId);
	} catch {
		//the output vanished or is not permitted; stay on the default
	}
}

export function onDeviceChange(handler) {
	navigator.mediaDevices?.addEventListener?.('devicechange', handler);
	return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
}
