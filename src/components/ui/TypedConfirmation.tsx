import { useState, useId, useEffect, type ReactNode } from "react";

export type SafetyWord = "FIRE" | "HALT";

export interface TypedConfirmationProps {
  safetyWord: SafetyWord;
  hint?: ReactNode;
  autoFocus?: boolean;
  onArmedChange?: (armed: boolean) => void;
}

// Returns whether the user has typed the safety word exactly.
// Comparison is case-sensitive — the design's safety words are
// uppercase letters and we want the keystroke load to match the
// intent. No trimming, no normalization.
export function isArmed(input: string, safetyWord: SafetyWord): boolean {
  return input === safetyWord;
}

export function TypedConfirmation({
  safetyWord,
  hint,
  autoFocus,
  onArmedChange,
}: TypedConfirmationProps) {
  const [value, setValue] = useState("");
  const armed = isArmed(value, safetyWord);
  const id = useId();

  useEffect(() => {
    onArmedChange?.(armed);
  }, [armed, onArmedChange]);

  return (
    <div className="typed-confirm">
      <label htmlFor={id} className="typed-confirm-label">
        {hint ?? (
          <>
            Type <code>{safetyWord}</code> to confirm
          </>
        )}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus={autoFocus}
        className={`typed-confirm-input${armed ? " armed" : ""}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`type ${safetyWord} to confirm`}
      />
    </div>
  );
}
