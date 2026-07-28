import { DurableObject } from 'cloudflare:workers';

// Long enough to cover a full call; credentials are minted per page load.
const TURN_TTL_SECONDS = 2 * 60 * 60;

// Fallback when no TURN key is configured. Enough for most networks, but peers
// behind symmetric NAT or restrictive firewalls will fail to connect.
const STUN_ONLY = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

export class Veet extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.storage = ctx.storage;

		//keep track of connected sessions
		this.sessions = new Map();
		this.ctx.getWebSockets().forEach((ws) => {
			this.sessions.set(ws, { ...ws.deserializeAttachment() });
		});
	}
	async fetch(_req) {
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		this.sessions.set(pair[1], {});
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	webSocketMessage(ws, msg) {
		const session = this.sessions.get(ws);
		if (!session.id) {
			session.id = crypto.randomUUID();
			ws.serializeAttachment({ ...ws.deserializeAttachment(), id: session.id });
			ws.send(JSON.stringify({ ready: true, id: session.id }));
		}
		this.broadcast(ws, msg);
	}
	broadcast(sender, msg) {
		const id = this.sessions.get(sender).id;
		for (let [ws] of this.sessions) {
			if (sender == ws) continue;
			switch (typeof msg) {
				case 'string':
					ws.send(JSON.stringify({ ...JSON.parse(msg), id }));
					break;
				default:
					ws.send(JSON.stringify({ ...msg, id }));
					break;
			}
		}
	}
	close(ws) {
		const session = this.sessions.get(ws);
		if (!session?.id) return;
		this.broadcast(ws, { type: 'left' });
		this.sessions.delete(ws);
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
