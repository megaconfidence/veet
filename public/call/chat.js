// The in-call chat panel. Purely a view: it renders whatever it is handed and
// reports what the user typed. Delivery is the caller's problem.

export const CHAT_MAX = 2000;

// Old messages are dropped from the DOM rather than kept forever — nothing here
// is persisted, so there is no reason to grow without bound.
const KEEP = 200;

const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function createChat({ onSend } = {}) {
	const panel = document.getElementById('chat');
	const list = document.getElementById('chat-log');
	const form = document.getElementById('chat-form');
	const input = document.getElementById('chat-input');
	const button = document.getElementById('chat-ctl');
	const badge = document.getElementById('chat-unread');
	const empty = document.getElementById('chat-empty');

	input.maxLength = CHAT_MAX;

	let unread = 0;
	let lastFrom = null; //{ mine, name } of the previous message, for grouping

	const isOpen = () => document.body.classList.contains('chat-open');

	function setUnread(count) {
		unread = count;
		badge.textContent = count > 9 ? '9+' : String(count);
		badge.hidden = count == 0;
	}

	function open() {
		document.body.classList.add('chat-open');
		button.setAttribute('aria-expanded', 'true');
		setUnread(0);
		// Let the grid settle before grabbing focus, or the panel jumps.
		requestAnimationFrame(() => input.focus());
		scrollToEnd();
	}

	function close() {
		document.body.classList.remove('chat-open');
		button.setAttribute('aria-expanded', 'false');
		button.focus();
	}

	const toggle = () => (isOpen() ? close() : open());

	function scrollToEnd() {
		list.scrollTop = list.scrollHeight;
	}

	// Runs of messages from one person collapse into a single labelled group.
	function append({ name, text, mine = false, at = Date.now(), system = false }) {
		// Detached, not hidden: a `display: none` first child is still the CSS
		// :first-child, which would swallow the auto margin that bottom-anchors
		// the log. No-op once it is already gone.
		empty.remove();

		if (system) {
			const note = document.createElement('p');
			note.className = 'chat-system';
			note.textContent = text;
			list.append(note);
			lastFrom = null;
		} else {
			if (!lastFrom || lastFrom.mine != mine || lastFrom.name != name) {
				const head = document.createElement('p');
				head.className = 'chat-who';
				head.textContent = mine ? 'You' : name;

				const stamp = document.createElement('time');
				stamp.dateTime = new Date(at).toISOString();
				stamp.textContent = time(at);
				head.append(stamp);

				list.append(head);
				lastFrom = { mine, name };
			}

			const line = document.createElement('p');
			line.className = 'chat-line';
			line.classList.toggle('mine', mine);
			line.textContent = text; //never innerHTML: this is text from a peer
			list.append(line);
		}

		while (list.children.length > KEEP) list.firstElementChild.remove();

		// Only follow the conversation if the reader is already at the bottom.
		const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
		if (pinned || mine) scrollToEnd();
		if (!isOpen() && !mine && !system) setUnread(unread + 1);
	}

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		input.value = '';
		input.style.height = 'auto';
		onSend?.(text.slice(0, CHAT_MAX));
	});

	// Enter sends, Shift+Enter makes a new line.
	input.addEventListener('keydown', (e) => {
		if (e.key == 'Enter' && !e.shiftKey) {
			e.preventDefault();
			form.requestSubmit();
		}
	});

	// Grow the box with the message, up to a point.
	input.addEventListener('input', () => {
		input.style.height = 'auto';
		input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
	});

	button.addEventListener('click', toggle);
	document.getElementById('chat-close').addEventListener('click', close);

	panel.addEventListener('keydown', (e) => {
		if (e.key == 'Escape') close();
	});

	return { open, close, toggle, append, isOpen };
}
