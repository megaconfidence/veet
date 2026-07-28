import { DurableObject } from 'cloudflare:workers';

// Long enough to cover a full call; credentials are minted per page load.
const TURN_TTL_SECONDS = 2 * 60 * 60;

// Fallback when no TURN key is configured. Enough for most networks, but peers
// behind symmetric NAT or restrictive firewalls will fail to connect.
const STUN_ONLY = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

// A full mesh needs point-to-point delivery: an offer meant for one peer must not
// reach the others. Messages carrying `to` are routed; everything else fans out.
export class Veet extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);

		//keep track of connected sessions
		this.sessions = new Map();
		this.ctx.getWebSockets().forEach((ws) => {
			this.sessions.set(ws, { ...ws.deserializeAttachment() });
		});
	}
	async fetch(_req) {
		const pair = new WebSocketPair();
		const server = pair[1];
		this.ctx.acceptWebSocket(server);

		const id = crypto.randomUUID();
		server.serializeAttachment({ id });

		// Snapshot the roster before registering, so the newcomer does not see itself.
		// Only the newcomer dials out, which keeps the mesh free of offer glare.
		const peers = [...this.sessions.values()].map((s) => s.id);
		this.sessions.set(server, { id });

		server.send(JSON.stringify({ type: 'ready', id, peers }));
		this.relay({ type: 'joined', from: id }, id);

		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	webSocketMessage(ws, raw) {
		const session = this.sessions.get(ws);
		if (!session) return;

		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return; //ignore anything that is not JSON
		}
		this.relay({ ...msg, from: session.id }, session.id, msg.to);
	}
	relay(msg, fromId, toId) {
		const body = JSON.stringify(msg);
		for (const [ws, s] of this.sessions) {
			if (s.id == fromId) continue;
			if (toId && s.id != toId) continue;
			try {
				ws.send(body);
			} catch {
				//peer went away mid-broadcast; close handlers will clean it up
			}
		}
	}
	close(ws) {
		const session = this.sessions.get(ws);
		if (!session) return;
		this.sessions.delete(ws);
		this.relay({ type: 'left', from: session.id }, session.id);
	}
	webSocketClose(ws) {
		this.close(ws);
	}
	webSocketError(ws) {
		this.close(ws);
	}
}

// Mints short-lived TURN credentials so the long-term key never reaches the browser.
async function iceServers(env) {
	const noStore = { 'Cache-Control': 'no-store' };
	const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = env;

	if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) {
		return Response.json(STUN_ONLY, { headers: noStore });
	}

	const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
	});

	if (!res.ok) {
		console.error(`TURN credential request failed: ${res.status} ${await res.text()}`);
		return Response.json(STUN_ONLY, { headers: noStore });
	}
	return Response.json(await res.json(), { headers: noStore });
}

export default {
	async fetch(request, env, _ctx) {
		const { pathname } = new URL(request.url);

		// Signalling. One Durable Object per meeting id.
		if (pathname.startsWith('/ws/')) {
			if (request.headers.get('Upgrade') != 'websocket') {
				return new Response('Expected upgrade to websocket', { status: 426 });
			}
			const meeting = pathname.slice('/ws/'.length);
			if (!meeting) return new Response('Missing meeting id', { status: 400 });

			const id = env.VEET.idFromName(meeting);
			return env.VEET.get(id).fetch(request);
		}

		if (pathname == '/ice') return iceServers(env);

		return env.ASSETS.fetch(request);
	},
};
