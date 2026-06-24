import { TelegramConfig } from "../config.js";

export async function sendTelegram(config: TelegramConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const errors: string[] = [];
  let sent = 0;
  for (const chatId of config.chatIds ?? []) {
    const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    if (res.ok) sent++;
    else errors.push(`${chatId}: ${res.status} ${await res.text()}`);
  }
  if (sent === 0 && errors.length) throw new Error(`Telegram error — ${errors.join("; ")}`);
}
