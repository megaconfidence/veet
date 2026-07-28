// The display name a participant chooses for themselves.

const STORAGE_KEY = 'veet.name';

export const NAME_MAX = 32;

// Names are rendered next to video and announced to every peer, so collapse
// whitespace and cap the length before either happens.
export const cleanName = (value) =>
	String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, NAME_MAX);

export function loadName() {
	try {
		return cleanName(localStorage.getItem(STORAGE_KEY));
	} catch {
		return ''; //private mode
	}
}

export function saveName(value) {
	const name = cleanName(value);
	try {
		if (name) localStorage.setItem(STORAGE_KEY, name);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		//not fatal: the name still applies for this session
	}
	return name;
}
