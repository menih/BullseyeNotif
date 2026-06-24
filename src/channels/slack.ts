export interface SlackConfig {
  enabled: boolean;
  webhookUrl: string;
  botToken?: string;
  channels?: string[];
}

const EMOJI_MAP: Record<string, string> = { low: "ℹ️", normal: "🔔", high: "🚨" };

export async function sendSlack(
  config: SlackConfig,
  message: string,
  priority: "low" | "normal" | "high" = "normal",
  title = "Claude Notify",
): Promise<void> {
  if (!config.enabled) return;
  const emoji = EMOJI_MAP[priority] ?? EMOJI_MAP.normal;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `${emoji} *${title}*\n${message}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Priority: ${priority} · <!date^${Math.floor(Date.now() / 1000)}^{time}|now>` }] },
  ];

  if (config.botToken && config.channels?.length) {
    const errors: string[] = [];
    let sent = 0;
    for (const channel of config.channels) {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.botToken}` },
        body: JSON.stringify({ channel, text: `${emoji} *${title}*`, blocks }),
      });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) sent++;
      else errors.push(`${channel}: ${json.error ?? res.status}`);
    }
    if (sent === 0 && errors.length) throw new Error(`Slack error — ${errors.join("; ")}`);
    return;
  }

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `${emoji} *${title}*`, blocks }),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);
}
