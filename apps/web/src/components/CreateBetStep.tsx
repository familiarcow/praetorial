// MODAL1c1: the create form (bet type -> fill -> stake) inside the FlowModal. CreateOffer keeps all its logic; this only
// mirrors its step into the flow (progress bar, draft) and feeds it the draft to start from.
import React, { useEffect, useRef } from "react";
import CreateOffer, { type CreateDraft } from "./CreateOffer";
import type { StructuredOffer } from "./ReviewCard";
import type { FlowApi } from "../modal/FlowModal";
import type { UserRegistry } from "../../lib/refereeRegistry";
import { decodeCreateDraft, encodeCreateDraft, stepIndexFor, type CreateStepId } from "../../lib/createBetFlow";

export function StepSync({ id, onStep }: { id: CreateStepId; onStep: (id: CreateStepId) => void }) {
  useEffect(() => { onStep(id); }, [id]);
  return null;
}

/** A resumed draft that was on the review has no offer any more: land on the stake step, where Review offer rebuilds it. */
export function ResumeToStake({ api }: { api: FlowApi }) {
  useEffect(() => { api.goTo(stepIndexFor("resolver")); }, []);
  return null;
}

export default function CreateBetStep({ api, fallbackDraft, onDraft, makerAccount, refereeRegistry, copyInfo, onSubmit }: {
  api: FlowApi;
  fallbackDraft: CreateDraft | null;
  onDraft: (d: CreateDraft) => void;
  makerAccount: string | null;
  refereeRegistry?: UserRegistry;
  copyInfo: { banner: string; notes: string[] } | null;
  onSubmit: (o: StructuredOffer) => void;
}) {
  // The App's own draft wins (Edit, Fix the bet, copied bet); the saved flow draft is only for a resume after a reload.
  const initial = useRef<CreateDraft | null>(fallbackDraft ?? decodeCreateDraft<CreateDraft>(api.values.draft)).current;
  const last = useRef<string | null>(null);
  const apiRef = useRef(api); apiRef.current = api;
  return (
    <CreateOffer
      makerAccount={makerAccount}
      refereeRegistry={refereeRegistry}
      draft={initial}
      copyInfo={copyInfo}
      onSubmit={onSubmit}
      onDraft={(d) => {
        onDraft(d);
        const enc = encodeCreateDraft(d);
        const first = last.current === null;
        last.current = enc;
        // The first report is just the form mounting with what it was given: not an edit, so it must not mark the flow dirty.
        if (first && enc === (apiRef.current.values.draft ?? enc) && d.step === "type") return;
        if (first && initial === null) return;
        if (enc !== apiRef.current.values.draft) apiRef.current.set("draft", enc);
        const idx = stepIndexFor(d.step);
        if (idx !== apiRef.current.index) apiRef.current.goTo(idx);
      }}
    />
  );
}
