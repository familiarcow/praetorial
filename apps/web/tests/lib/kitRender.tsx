// B1: static renders of the kit for node unit tests (tests/betDetail.unit.test.ts). Import AFTER ./assetStubs (dynamic import).
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BetTerms, BetSources, JudgeInfo, RulingHistory, MoneyDeadlines, AccountDetails, DetailsCard, ExhibitList, type DetailSection } from "../../src/kit";
import Playground, { BetPageState } from "../../src/kit/Playground";
import { ToastProvider } from "../../src/kit/Toast";
import type { BetDetail } from "../../lib/betDetail";
import type { BetView } from "../../lib/betView";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
export const terms = (d: BetDetail) => html(<BetTerms terms={d.terms} />);
export const sources = (d: BetDetail) => html(<BetSources sources={d.sources} />);
export const judge = (d: BetDetail) => html(<JudgeInfo judge={d.judge} />);
export const ruling = (d: BetDetail) => html(<RulingHistory ruling={d.ruling} />);
export const money = (d: BetDetail) => html(<MoneyDeadlines money={d.money} deadlines={d.deadlines} />);
export const accounts = (d: BetDetail, contractId?: string) => html(<AccountDetails accounts={d.accounts} contractId={contractId} />);
export const exhibits = (x: BetDetail["exhibits"]) => html(<ExhibitList exhibits={x} />);
export const card = (d: BetDetail, contractId?: string, open: DetailSection[] | "all" = []) => html(<DetailsCard detail={d} contractId={contractId} open={open} />);
export const state = (f: { key: string; label: string; id: number }, v: BetView, d: BetDetail) => html(<ToastProvider><BetPageState f={f} v={v} d={d} open="all" /></ToastProvider>);
export const playground = () => html(<ToastProvider><Playground /></ToastProvider>);
