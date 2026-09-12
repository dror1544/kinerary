import { useId, useState } from "react";
import { Star } from "lucide-react";
import { tr, type Lang } from "./parity-ui";

export function StarRating({ value = 0, disabled = false, lang, onChange }: {
  value?: number;
  disabled?: boolean;
  lang: Lang;
  onChange: (value: number) => void;
}) {
  const name = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const shown = disabled ? value : preview ?? value;
  return (
    <fieldset className="star-rating" disabled={disabled} dir={lang === "he" ? "rtl" : "ltr"}>
      <legend>{tr(lang, "Your rating", "הדירוג שלך")}</legend>
      <div className="star-rating-options" onMouseLeave={() => setPreview(null)}>
        {[1, 2, 3, 4, 5].map(n => (
          <label key={n} className={`star-rating-option${n <= shown ? " is-filled" : ""}`} onMouseEnter={() => { if (!disabled) setPreview(n); }}>
            <input type="radio" name={name} value={n} checked={value === n}
              aria-label={tr(lang, `${n} out of 5 stars`, `${n} מתוך 5 כוכבים`)}
              onChange={() => { setPreview(null); onChange(n); }} />
            <Star size={32} aria-hidden="true" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
