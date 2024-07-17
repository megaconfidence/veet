import { DurableObject } from 'cloudflare:workers';

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

export default {
	async fetch(request, env, _ctx) {
		const upgrade = request.headers.get('Upgrade');
		if (!upgrade || upgrade != 'websocket') {
			return new Response('Expected upgrade to websocket', { status: 426 });
		}
		const id = env.VEET.idFromName(new URL(request.url).pathname);
		const veet = env.VEET.get(id);
		return veet.fetch(request);
	},
};
