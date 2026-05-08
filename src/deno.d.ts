declare const Deno: {
	serve(handler: (req: Request) => Response | Promise<Response>): void;
	upgradeWebSocket(req: Request): { socket: WebSocket; response: Response };
};
