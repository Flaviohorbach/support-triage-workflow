export const clientIp = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
