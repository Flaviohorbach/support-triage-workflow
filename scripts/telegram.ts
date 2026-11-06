// Telegram setup helper. Reads the token from .env.local and never prints it.
//   npm run setup:telegram -- me                  check the token
//   npm run setup:telegram -- chats               chat ids that wrote to the bot (needs no webhook set)
//   npm run setup:telegram -- webhook <site url>  point the bot at <site url>/api/telegram
//   npm run setup:telegram -- info                webhook status and last error
//   npm run setup:telegram -- delete-webhook

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing in .env.local");
  process.exit(1);
}

async function api(method: string, body?: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case "me": {
    const me = (await api("getMe")) as { username: string };
    console.log(`Bot: @${me.username} (https://t.me/${me.username})`);
    break;
  }
  case "chats": {
    const updates = (await api("getUpdates")) as { message?: { chat: { id: number; type: string } } }[];
    const chats = new Map(updates.flatMap((u) => (u.message ? [[u.message.chat.id, u.message.chat.type] as const] : [])));
    if (chats.size === 0) console.log("No messages yet. Send any message to the bot, then run this again.");
    for (const [id, type] of chats) console.log(`${id}\t${type}`);
    break;
  }
  case "webhook": {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!arg || !secret) throw new Error("Usage: webhook https://your-site.vercel.app (and set TELEGRAM_WEBHOOK_SECRET)");
    const url = `${arg.replace(/\/$/, "")}/api/telegram`;
    await api("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
    console.log(`Webhook set to ${url}`);
    break;
  }
  case "info": {
    const info = (await api("getWebhookInfo")) as { url: string; pending_update_count: number; last_error_message?: string };
    console.log(`URL: ${info.url || "(none)"}\nPending updates: ${info.pending_update_count}\nLast error: ${info.last_error_message ?? "none"}`);
    break;
  }
  case "delete-webhook":
    await api("deleteWebhook");
    console.log("Webhook removed");
    break;
  default:
    console.log("Commands: me, chats, webhook <url>, info, delete-webhook");
}

export {};
