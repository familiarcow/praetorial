import React from "react";
import { Button as AButton } from "@astryxdesign/core/Button";
import { Card as ACard } from "@astryxdesign/core/Card";
import { Banner as ABanner } from "@astryxdesign/core/Banner";

// ASTRYX1: thin adapters so existing screens keep their native-shaped props (disabled, data-testid, onClick, children)
// while rendering Astryx components. LOOK only; behaviour and copy are unchanged.
function textOf(n: React.ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (React.isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children);
  return "";
}

type BtnProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  [k: `data-${string}`]: unknown;
};

export function Button({ children, disabled, variant, size, onClick, type, ...rest }: BtnProps) {
  return (
    <AButton
      {...(rest as object)}
      label={textOf(children) || (rest["aria-label"] as string) || "button"}
      variant={variant ?? "secondary"}
      size={size}
      type={type ?? "button"}
      isDisabled={disabled}
      onClick={onClick as never}
    >
      {children}
    </AButton>
  );
}

export function Banner({ status, children, ...rest }: { status: "info" | "warning" | "error" | "success"; children: React.ReactNode; [k: `data-${string}`]: unknown; role?: string }) {
  return <ABanner {...(rest as object)} status={status} title={children} />;
}

import { ClickableCard as AClickableCard } from "@astryxdesign/core/ClickableCard";
export function ClickCard({ label, onClick, children, ...rest }: { label: string; onClick: () => void; children: React.ReactNode; [k: `data-${string}`]: unknown }) {
  return <AClickableCard {...(rest as object)} label={label} onClick={onClick} padding={3} maxWidth={560}>{children}</AClickableCard>;
}

export function Card({ children, ...rest }: { children: React.ReactNode; style?: React.CSSProperties; [k: `data-${string}`]: unknown }) {
  return <ACard {...(rest as object)} padding={3} maxWidth={560}>{children}</ACard>;
}

// ASTRYX1b: native-shaped field adapters. data-* and testids are forwarded to the Astryx field (checked in e2e);
// onChange receives the native change event so call sites keep e.currentTarget.value / .checked.
import { TextInput as ATextInput } from "@astryxdesign/core/TextInput";
import { CheckboxInput as ACheckboxInput } from "@astryxdesign/core/CheckboxInput";

type FieldBase = { label: string; hideLabel?: boolean; disabled?: boolean; [k: `data-${string}`]: unknown };

export function TextField({
  label, hideLabel, disabled, value, onChange, type, placeholder, style, inputMode, autoCapitalize, autoCorrect, autoComplete, spellCheck, step, readOnly, onFocus, ...rest
}: FieldBase & {
  value: string | number;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: "text" | "email" | "password" | "search" | "tel" | "url" | "number" | "date" | "datetime-local";
  style?: React.CSSProperties;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  autoCapitalize?: string;
  autoCorrect?: string;
  autoComplete?: string;
  spellCheck?: boolean;
  step?: string;
  readOnly?: boolean;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
}) {
  const extra = { ...rest, type, step, autoCorrect, autoComplete, spellCheck } as object;
  const field = (
    <ATextInput
      {...extra}
      label={label}
      isLabelHidden={hideLabel}
      isDisabled={disabled}
      isReadOnly={readOnly}
      onFocus={onFocus as never}
      value={String(value)}
      onChange={((_v: string, e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e)) as never}
      placeholder={placeholder}
      inputMode={inputMode as never}
      autoCapitalize={autoCapitalize as never}
    />
  );
  return style ? <div style={style}>{field}</div> : field;
}

export function CheckField({
  label, disabled, checked, onChange, ...rest
}: FieldBase & { checked: boolean; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <ACheckboxInput
      {...(rest as object)}
      label={label}
      isDisabled={disabled}
      value={checked}
      onChange={((_c: boolean, e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e)) as never}
    />
  );
}

// Alert = Astryx Banner that keeps role="alert" + testid (inline error messages).
export function Alert({ children, ...rest }: { children: React.ReactNode; [k: `data-${string}`]: unknown }) {
  return <ABanner {...(rest as object)} role="alert" status="error" title={children} />;
}

import { TextArea as ATextArea } from "@astryxdesign/core/TextArea";
export function TextAreaField({
  label, hideLabel, disabled, value, onChange, placeholder, ...rest
}: FieldBase & { value: string; onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void; placeholder?: string }) {
  return (
    <ATextArea
      {...(rest as object)}
      label={label}
      isLabelHidden={hideLabel}
      isDisabled={disabled}
      value={value}
      onChange={((_v: string, e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e)) as never}
      placeholder={placeholder}
    />
  );
}
