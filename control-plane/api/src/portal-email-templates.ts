import type { MailMessage } from "./mailer.js";

export type MailLanguage = "en" | "he";

/** `he` only when asked for (body) or preferred (Accept-Language); English otherwise. */
export function pickLanguage(requested: unknown, acceptLanguage: unknown): MailLanguage {
  if (requested === "he" || requested === "en") return requested;
  if (typeof acceptLanguage === "string" && /^\s*he\b/i.test(acceptLanguage)) return "he";
  return "en";
}

export type PortalMail =
  | { kind: "verify"; link: string; displayName: string; ttlHours: number }
  | { kind: "reset"; link: string; ttlMinutes: number }
  | { kind: "existing"; signInUrl: string; resetUrl: string };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Copy { subject: string; lines: string[]; action?: { label: string; url: string }; footer: string }

function copy(mail: PortalMail, language: MailLanguage): Copy {
  if (language === "he") {
    switch (mail.kind) {
      case "verify": return {
        subject: "אימות הכתובת שלך ב-Kinerary",
        lines: [`שלום ${mail.displayName},`, `כדי לסיים את יצירת החשבון, אשרו את כתובת האימייל. הקישור תקף ל-${mail.ttlHours} שעות ופועל פעם אחת בלבד.`],
        action: { label: "אישור הכתובת", url: mail.link },
        footer: "אם לא ביקשתם ליצור חשבון ב-Kinerary, אפשר להתעלם מהמכתב הזה. לא ייווצר חשבון.",
      };
      case "reset": return {
        subject: "איפוס הסיסמה ב-Kinerary",
        lines: [`קיבלנו בקשה לאפס את הסיסמה לחשבון שלכם. הקישור תקף ל-${mail.ttlMinutes} דקות ופועל פעם אחת בלבד.`],
        action: { label: "בחירת סיסמה חדשה", url: mail.link },
        footer: "אם לא ביקשתם לאפס את הסיסמה, אפשר להתעלם מהמכתב הזה. הסיסמה הנוכחית נשארת כפי שהיא.",
      };
      case "existing": return {
        subject: "כבר יש לכם חשבון ב-Kinerary",
        lines: [
          "מישהו (כנראה אתם) ניסה ליצור חשבון Kinerary עם הכתובת הזו, אבל כבר קיים חשבון על הכתובת הזו.",
          `להתחברות: ${mail.signInUrl}`,
          `שכחתם את הסיסמה? אפשר לאפס אותה כאן: ${mail.resetUrl}`,
        ],
        footer: "אם לא ניסיתם ליצור חשבון, אפשר להתעלם מהמכתב הזה. שום דבר לא השתנה בחשבון שלכם.",
      };
    }
  }
  switch (mail.kind) {
    case "verify": return {
      subject: "Confirm your email address for Kinerary",
      lines: [`Hi ${mail.displayName},`, `To finish creating your account, confirm your email address. The link works once and is valid for ${mail.ttlHours} hours.`],
      action: { label: "Confirm my email", url: mail.link },
      footer: "If you didn't ask for a Kinerary account, you can ignore this message. No account will be created.",
    };
    case "reset": return {
      subject: "Reset your Kinerary password",
      lines: [`We received a request to reset the password for your account. The link works once and is valid for ${mail.ttlMinutes} minutes.`],
      action: { label: "Choose a new password", url: mail.link },
      footer: "If you didn't ask for this, you can ignore this message. Your current password stays as it is.",
    };
    case "existing": return {
      subject: "You already have a Kinerary account",
      lines: [
        "Someone (probably you) tried to create a Kinerary account with this address, but an account already exists for it.",
        `Sign in: ${mail.signInUrl}`,
        `Forgot your password? Reset it here: ${mail.resetUrl}`,
      ],
      footer: "If you didn't try to sign up, you can ignore this message. Nothing about your account has changed.",
    };
  }
}

/** Plain text plus simple HTML. The link is the only thing the message is for, so it is in both, in full. */
export function renderPortalMail(mail: PortalMail, language: MailLanguage, to: string): MailMessage {
  const c = copy(mail, language);
  const text = [...c.lines, ...(c.action ? [`${c.action.label}: ${c.action.url}`] : []), "", c.footer].join("\n\n");
  const para = (line: string) => `<p>${escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`)}</p>`;
  const button = c.action
    ? `<p><a href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:12px 20px;background:#e8604c;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(c.action.label)}</a></p>`
      + `<p style="color:#666666;font-size:13px">${escapeHtml(c.action.url)}</p>`
    : "";
  const dir = language === "he" ? "rtl" : "ltr";
  const html = `<!doctype html><html lang="${language}" dir="${dir}"><body dir="${dir}" style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.5;color:#1d2433">`
    + `${c.lines.map(para).join("")}${button}<p style="color:#666666;font-size:13px">${escapeHtml(c.footer)}</p></body></html>`;
  return { to, subject: c.subject, text, html };
}
