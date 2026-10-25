import { z } from "zod";

// Shared between client forms and server handlers. The server always re-validates.

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const timezoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(254));

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long");

export const displayNameSchema = z.string().trim().min(2, "Name is too short").max(80);

export const signupSchema = z
  .object({
    displayName: displayNameSchema,
    email: emailSchema,
    password: passwordSchema,
    timezone: timezoneSchema.default("UTC"),
    workspaceMode: z.enum(["create", "join"]),
    workspaceName: z.string().trim().max(80).optional(),
    joinCode: z.string().trim().toLowerCase().max(32).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.workspaceMode === "create" && (!v.workspaceName || v.workspaceName.length < 2)) {
      ctx.addIssue({ code: "custom", path: ["workspaceName"], message: "Enter a workspace name" });
    }
    if (v.workspaceMode === "join" && !v.joinCode) {
      ctx.addIssue({ code: "custom", path: ["joinCode"], message: "Enter the workspace join code" });
    }
  });
export type SignupInput = z.input<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(128),
});

// Languages the assistant and captions can use. Speech recognition currently supports en and hi;
// the others are available for translated captions and assistant text.
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi (हिन्दी)" },
  { code: "bn", name: "Bengali (বাংলা)" },
  { code: "ta", name: "Tamil (தமிழ்)" },
  { code: "te", name: "Telugu (తెలుగు)" },
  { code: "mr", name: "Marathi (मराठी)" },
  { code: "gu", name: "Gujarati (ગુજરાતી)" },
  { code: "kn", name: "Kannada (ಕನ್ನಡ)" },
  { code: "ml", name: "Malayalam (മലയാളം)" },
  { code: "pa", name: "Punjabi (ਪੰਜਾਬੀ)" },
  { code: "ur", name: "Urdu (اردو)" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "zh", name: "Chinese (中文)" },
  { code: "ja", name: "Japanese (日本語)" },
  { code: "ko", name: "Korean (한국어)" },
  { code: "ar", name: "Arabic (العربية)" },
  { code: "vi", name: "Vietnamese (Tiếng Việt)" },
] as const;
export const languageSchema = z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]]);
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +919812345678"));

export const profileUpdateSchema = z.object({
  displayName: displayNameSchema,
  title: z.string().trim().max(80).nullable().optional(),
  department: z.string().trim().max(80).nullable().optional(),
  timezone: timezoneSchema,
  preferredLanguage: languageSchema.optional(),
  phoneNumber: z.union([phoneSchema, z.literal(""), z.null()]).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const directorySearchSchema = z.object({
  q: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const memberRoleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]),
});

export const workspaceSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  allowExternalInvites: z.boolean().optional(),
  agentAutoExecute: z.boolean().optional(),
  transcriptRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});
