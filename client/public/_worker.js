export default {
	async fetch(request, env, _ctx) {
		return env.ASSETS.fetch(request);
	},
};
