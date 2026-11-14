import React, { useId } from "react";
import { Drawer as ADrawer } from "@astryxdesign/core/Drawer";

export interface DrawerProps {
  isOpen: boolean;
  onRequestClose: () => void;
  /** Accessible name, also shown as the heading. */
  title: string;
  side?: "start" | "end";
  busy?: boolean;
  children: React.ReactNode;
}

/** Side panel for secondary, non-money content (filters, notifications, details). Same close rules as Modal. */
export function Drawer({ isOpen, onRequestClose, title, side = "end", busy = false, children }: DrawerProps) {
  const titleId = useId();
  return (
    <ADrawer aria-labelledby={titleId} isOpen={isOpen} onOpenChange={(o) => { if (!o && !busy) onRequestClose(); }} label={title} side={side} width={360}>
      <h2 id={titleId} style={{ margin: "0 0 12px", fontSize: 20 }}>{title}</h2>
      {children}
    </ADrawer>
  );
}
