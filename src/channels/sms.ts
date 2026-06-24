import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { SmsConfig } from "../config.js";

export async function sendSms(config: SmsConfig, message: string): Promise<void> {
  if (!config.enabled) return;
  const client = new PinpointSMSVoiceV2Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const errors: string[] = [];
  let sent = 0;
  const e164 = (s: string) => String(s ?? "").replace(/[^\d+]/g, "");
  for (const to of config.to ?? []) {
    try {
      await client.send(new SendTextMessageCommand({
        DestinationPhoneNumber: e164(to),
        OriginationIdentity: e164(config.originationNumber) || undefined,
        MessageBody: message,
      }));
      sent++;
    } catch (err) {
      errors.push(`${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sent === 0 && errors.length) throw new Error(`SMS error — ${errors.join("; ")}`);
}
