/**
 * Checks the SMTP settings in .env by logging in to the mail server.
 * Sends nothing. Usage: npm run email:verify
 */
import "dotenv/config";
import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT = "465", SMTP_USER, SMTP_PASSWORD } = process.env;
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
  console.error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  connectionTimeout: 10_000,
});

transport
  .verify()
  .then(() => console.log(`✓ SMTP login OK for ${SMTP_USER} at ${SMTP_HOST}:${SMTP_PORT} (no email sent)`))
  .catch((err) => {
    console.error(`✗ SMTP verification failed: ${err.code ?? ""} ${err.response ?? err.message}`);
    process.exit(1);
  });
