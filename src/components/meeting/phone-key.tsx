import { cn } from "@/lib/utils";

/** A round in-call key with its label underneath (the button inside is styled by `.phone-key` in globals.css). */
export function Key({ label, small, children, className }: { label: string; small?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("phone-key", small && "is-small", className)}>
      {children}
      <span className="phone-key-label" aria-hidden>
        {label}
      </span>
    </div>
  );
}
