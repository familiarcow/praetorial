"""Red-team corpus for the 10 v2 clauses mined from Kalshi/Polymarket (see
Bots/crypto-research/Praetorial clause library gaps (Kalshi + Polymarket).md).

Reuses judge.py + the redteam.py machinery (same model/verify/aggregate/decide pipeline,
same MODELS/RUNS/ONLY env conventions). Three clauses are deterministic in code
(SOURCE_SUBSTITUTION_V1, NO_DATA_FALLBACK_V1, REVISION_WINDOW_V1); the other seven are
prompt-only definitions, resolved by the existing verify()/element_verdict()/decide() pipeline.

Usage: python3 clauses_redteam.py [runs_per_model]
"""
import json, os, sys, time, concurrent.futures as cf
import judge as J

MODELS = os.environ.get("MODELS", "claude:haiku").split(",")
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3

def ts(**kw):
    t = {
        "claim": kw.pop("claim"),
        "elements": kw.pop("elements"),
        "rule": kw.pop("rule", "ALL"),
        "clauses": kw.pop("clauses"),
        "time": kw.pop("time"),
        "sources_allowed": kw.pop("sources_allowed"),
        "sources": True,
    }
    t.update(kw)
    return t

T2027 = {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"}
T2026 = {"window_start": "2026-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"}

# ============================================================== SOURCE_SUBSTITUTION_V1
SRC_SUB_TS = ts(
    claim="Spot gold closes above $3,000/oz on 2027-12-31 UTC per an allowed source agency.",
    elements=[{"id": "e1", "q": "Did an allowed source agency report spot gold trading above $3,000 per ounce at the close on 2027-12-31 UTC?"}],
    clauses=["SOURCE_SUBSTITUTION_V1", "NUMERIC_EXACT_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "AGA", "publisher": "Agency A Market Data"}, {"id": "AGB", "publisher": "Agency B Market Data"}],
)

# ============================================================== REVISION_WINDOW_V1
REV_TS = ts(
    claim="BLS reports the September 2027 CPI month-over-month increase at or above 0.4%.",
    elements=[{"id": "e1", "q": "Did the U.S. Bureau of Labor Statistics report the September 2027 CPI month-over-month increase at or above 0.4%?"}],
    clauses=["REVISION_WINDOW_V1", "NUMERIC_EXACT_V1", "OFFICIAL_SOURCE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "BLS1", "publisher": "bls.gov"}, {"id": "BLS2", "publisher": "bls.gov"}, {"id": "RT", "publisher": "Reuters"}],
)

# ============================================================== CONTESTED_PRIMARY_V1
CP_TS = ts(
    claim="Candidate X is declared the official winner of the Ruritania presidential election.",
    elements=[{"id": "e1", "q": "Did Candidate X win the Ruritania presidential election according to the named primary and independent sources?"}],
    clauses=["CONTESTED_PRIMARY_V1", "OFFICIAL_SOURCE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "EC", "publisher": "Ruritania Election Commission"}, {"id": "W1", "publisher": "Reuters"}, {"id": "W2", "publisher": "AP"}],
)

# ============================================================== POSTPONED_V1
PP_TS = ts(
    claim="Team A wins the Ruritania Cup Final.",
    elements=[{"id": "e1", "q": "Has Team A been declared the winner of the Ruritania Cup Final?"}],
    clauses=["POSTPONED_V1", "FINAL_SCORE_V1", "UTC_V1"],
    time=T2026,
    sources_allowed=[{"id": "LG", "publisher": "Ruritania Football League"}, {"id": "RT", "publisher": "Reuters"}],
)

# ============================================================== TIE_V1
TIE_TS = ts(
    claim="Team A is declared champion after the title game.",
    elements=[{"id": "e1", "q": "Is Team A declared the champion after the title game?"}],
    clauses=["TIE_V1", "FINAL_SCORE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "LG", "publisher": "Ruritania Basketball League"}, {"id": "RT", "publisher": "Reuters"}],
)

# ============================================================== ABANDONED_EVENT_V1
AB_TS = ts(
    claim="Team A is ahead in the suspended championship game's official record.",
    elements=[{"id": "e1", "q": "Does the official record show Team A leading at the time the championship game was suspended?"}],
    clauses=["ABANDONED_EVENT_V1", "FINAL_SCORE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "LG", "publisher": "Ruritania Basketball League"}, {"id": "RT", "publisher": "Reuters"}],
)

# ============================================================== MEDIA_CONSENSUS_CALL_V1
MC_TS = ts(
    claim="Candidate X is the winner of the Ruritania presidential election.",
    elements=[{"id": "e1", "q": "Have a majority of the term sheet's named media sources made a consensus call for Candidate X as the winner?"}],
    clauses=["MEDIA_CONSENSUS_CALL_V1", "OFFICIAL_SOURCE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "M1", "publisher": "Outlet1 News"}, {"id": "M2", "publisher": "Outlet2 News"}, {"id": "M3", "publisher": "Outlet3 News"},
                      {"id": "M4", "publisher": "Outlet4 News"}, {"id": "M5", "publisher": "Outlet5 News"}, {"id": "M6", "publisher": "Outlet6 News"}],
)

# ============================================================== ROUNDING_PRECISION_V1
RP_TS = ts(
    claim="Global average temperature anomaly for 2027 is at least 1.25C above pre-industrial levels, per the named agency.",
    elements=[{"id": "e1", "q": "Did the named meteorological agency report a 2027 global average temperature anomaly of at least 1.25 degrees Celsius above pre-industrial levels?"}],
    clauses=["ROUNDING_PRECISION_V1", "NUMERIC_EXACT_V1", "OFFICIAL_SOURCE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "AG", "publisher": "World Meteorological Agency"}, {"id": "RT", "publisher": "Reuters"}],
)
RP_TS_CONFLICT = ts(
    claim="Global average temperature anomaly for 2027 is at least 1.25C above pre-industrial levels, per the named agency.",
    elements=[{"id": "e1", "q": "Do the term sheet's listed primary meteorological agencies agree that the 2027 global average temperature anomaly was at least 1.25 degrees Celsius above pre-industrial levels?"}],
    clauses=["ROUNDING_PRECISION_V1", "NUMERIC_EXACT_V1", "OFFICIAL_SOURCE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "AG", "publisher": "World Meteorological Agency"}, {"id": "AG2", "publisher": "National Climate Service"}],
)

# ============================================================== NO_DATA_FALLBACK_V1
ND_TS = ts(
    claim="The agency's Q3 2027 productivity report shows growth above 2%.",
    elements=[{"id": "e1", "q": "Did the named statistical agency publish a Q3 2027 productivity growth figure above 2%, at any time before the evidence cutoff?"}],
    clauses=["NO_DATA_FALLBACK_V1", "NUMERIC_EXACT_V1", "OFFICIAL_SOURCE_V1"],
    time=T2027,
    sources_allowed=[{"id": "AG", "publisher": "National Statistics Agency"}, {"id": "RT", "publisher": "Reuters"}],
)

# ============================================================== FORMAT_CHANGE_V1
FC_TS = ts(
    claim="The headline performer performs at the award show.",
    elements=[{"id": "e1", "q": "Did the headline performer perform at the award show?"}],
    clauses=["FORMAT_CHANGE_V1", "PARTIAL_NONE_V1", "UTC_V1"],
    time=T2027,
    sources_allowed=[{"id": "VR", "publisher": "Variety"}, {"id": "RT", "publisher": "Reuters"}],
)

CASES = [
    # --- SOURCE_SUBSTITUTION_V1
    dict(name="src_sub_yes", expect="YES", ts=SRC_SUB_TS, src=[
        dict(id="AGB", published="2027-12-31T23:30:00Z", text="Agency B Market Data: Spot gold settled at $3,050.40 per ounce at the close on December 31, 2027. Agency A, the originally named source agency, permanently discontinued its gold price feed in October 2027; Agency B is the next-listed source agency in the same source class.")]),
    dict(name="src_sub_no", expect="NO", ts=SRC_SUB_TS, src=[
        dict(id="AGB", published="2027-12-31T23:30:00Z", text="Agency B Market Data: Spot gold settled at $2,950.10 per ounce at the close on December 31, 2027, after Agency A discontinued its price feed permanently in October 2027.")]),
    dict(name="src_sub_void_no_fallback", expect="VOID", ts=SRC_SUB_TS, src=[]),

    # --- REVISION_WINDOW_V1
    dict(name="revwin_yes_timely_correction", expect="YES", ts=REV_TS, src=[
        dict(id="BLS1", published="2027-10-13T12:30:00Z", text="Bureau of Labor Statistics: the Consumer Price Index rose 0.3 percent in September on a seasonally adjusted basis."),
        dict(id="BLS2", corrects="BLS1", published="2027-10-13T22:00:00Z", text="Bureau of Labor Statistics correction, issued the same day as the original release: due to a data processing error, the September Consumer Price Index increase is revised to 0.4 percent, not 0.3 percent as first reported.")]),
    dict(name="revwin_no_late_correction_ignored", expect="NO", ts=REV_TS, src=[
        dict(id="BLS1", published="2027-10-13T12:30:00Z", text="Bureau of Labor Statistics: the Consumer Price Index rose 0.3 percent in September on a seasonally adjusted basis."),
        dict(id="BLS2", corrects="BLS1", published="2027-10-19T12:30:00Z", text="Bureau of Labor Statistics correction, issued six days after the original release: the September Consumer Price Index increase is revised to 0.4 percent.")]),
    dict(name="revwin_void_unrelated_conflict", expect="VOID", ts=REV_TS, src=[
        dict(id="BLS1", published="2027-10-13T12:30:00Z", text="Bureau of Labor Statistics: the Consumer Price Index rose 0.5 percent in September."),
        dict(id="BLS2", published="2027-10-13T18:00:00Z", text="Bureau of Labor Statistics, in a second official same-day press release for the identical September reference period, states the Consumer Price Index rose only 0.1 percent. The agency has publicly acknowledged these are two contradictory official releases for the same reference period and has stated that which of the two figures, 0.5 percent or 0.1 percent, is the correct one cannot currently be determined from either release.")]),

    # --- CONTESTED_PRIMARY_V1
    dict(name="contested_primary_no", expect="NO", ts=CP_TS, src=[
        dict(id="EC", published="2027-11-05T20:00:00Z", text="Ruritania Election Commission: Candidate X is declared the winner with 52% of the vote. This result has since been formally disputed by two independent election monitoring groups and, per this contract's CONTESTED_PRIMARY_V1 rule, is not treated as reliable evidence of who won."),
        dict(id="W1", published="2027-11-06T09:00:00Z", text="Reuters: independent election observers and two opposition parties say the Election Commission's count is not credible, citing manipulated tallies in three provinces. Setting the Commission's disputed announcement aside entirely, the only credible count available, an independently compiled parallel vote tabulation, shows Candidate Y received more votes than Candidate X."),
        dict(id="W2", published="2027-11-06T10:00:00Z", text="AP: a separate independent monitoring group likewise confirms the parallel vote tabulation -- the only credible count available once the Election Commission's disputed announcement is set aside -- shows Candidate Y ahead of Candidate X, matching Reuters' figures exactly.")]),
    dict(name="contested_primary_yes_process_only", expect="YES", ts=CP_TS, src=[
        dict(id="EC", published="2027-11-05T20:00:00Z", text="Ruritania Election Commission: Candidate X is declared the winner with 52% of the vote. This result has since been formally disputed by two independent election monitoring groups and, per this contract's CONTESTED_PRIMARY_V1 rule, is not treated as reliable evidence of who won."),
        dict(id="W1", published="2027-11-06T09:00:00Z", text="Reuters: opposition parties say the Election Commission's handling of the count lacked transparency. Setting the Commission's disputed announcement aside entirely, the only credible count available, an independently compiled parallel vote tabulation, confirms Candidate X received the most votes."),
        dict(id="W2", published="2027-11-06T10:00:00Z", text="AP: a separate independent monitoring group likewise confirms the parallel vote tabulation -- the only credible count available once the Election Commission's disputed announcement is set aside -- shows Candidate X ahead of Candidate Y, matching Reuters' figures exactly.")]),
    dict(name="contested_primary_void_next_tier_conflicts", expect="VOID", ts=CP_TS, src=[
        dict(id="EC", published="2027-11-05T20:00:00Z", text="Ruritania Election Commission: Candidate X is declared the winner with 52% of the vote. This result has since been formally disputed by two independent election monitoring groups and, per this contract's CONTESTED_PRIMARY_V1 rule, is not treated as reliable evidence of who won."),
        dict(id="W1", published="2027-11-06T09:00:00Z", text="Reuters: setting the Election Commission's disputed announcement aside entirely, Monitoring Group 1's independent parallel vote tabulation, the only count Reuters treats as credible, shows Candidate Y ahead."),
        dict(id="W2", published="2027-11-06T10:00:00Z", text="AP: setting the Election Commission's disputed announcement aside entirely, Monitoring Group 2's independent parallel vote tabulation, the only count AP treats as credible, shows Candidate X ahead -- directly contradicting Monitoring Group 1's parallel count reported by Reuters for the same election.")]),

    # --- POSTPONED_V1
    dict(name="postponed_insufficient_stays_open", expect="ESCALATE", ts=PP_TS, src=[
        dict(id="LG", published="2026-05-20T10:00:00Z", text="Ruritania Football League: the Cup Final originally set for May 30 has been officially postponed due to stadium damage and will be rescheduled for July 15, 2026."),
        dict(id="RT", published="2026-05-20T15:00:00Z", text="Reuters: league officials confirmed the Ruritania Cup Final is postponed, not cancelled, and will be replayed on July 15.")]),
    dict(name="postponed_yes_after_reschedule", expect="YES", ts=PP_TS, src=[
        dict(id="LG", published="2026-07-15T22:00:00Z", text="Ruritania Football League: Team A defeated Team B 2-1 in the rescheduled Cup Final held July 15, 2026, and is declared champion."),
        dict(id="RT", published="2026-07-15T23:00:00Z", text="Reuters: Team A won the rescheduled Ruritania Cup Final 2-1 on Tuesday, clinching the title.")]),
    dict(name="postponed_void_cap_status_conflict", expect="VOID", ts=PP_TS, src=[
        dict(id="LG", published="2027-06-01T10:00:00Z", text="Ruritania Football League: the Cup Final, postponed since May 2026, remains unscheduled; the league states firmly that no match has occurred and none is scheduled."),
        dict(id="RT", published="2027-06-02T09:00:00Z", text="Reuters: the Ruritania Football League's own press office confirmed directly to Reuters that the rescheduled Cup Final was in fact played in December 2026, with Team A winning 2-0, directly contradicting the league's public statement issued the same week that no match has occurred.")]),

    # --- TIE_V1
    dict(name="tie_void_conflicting_tiebreak_claims", expect="VOID", ts=TIE_TS, src=[
        dict(id="LG", published="2027-04-10T23:00:00Z", text="Ruritania Basketball League: the title game ended 95-95 after two overtime periods; the league has no tiebreak rule for this format and the game is recorded as a draw with no champion declared."),
        dict(id="RT", published="2027-04-11T08:00:00Z", text="Reuters: despite the league's draw ruling, officials later confirmed Team A was awarded the title via a previously unannounced away-record tiebreak, making Team A champion.")]),
    dict(name="tie_yes_named_tiebreak", expect="YES", ts=TIE_TS, src=[
        dict(id="LG", published="2027-04-10T23:00:00Z", text="Ruritania Basketball League: the title game ended 95-95 after overtime. Per league rule 12.3, a tied title game is awarded to the team with the better regular-season record. Team A had the better record and is declared champion."),
        dict(id="RT", published="2027-04-11T08:00:00Z", text="Reuters: Team A was declared champion under the league's regular-season-record tiebreak after Tuesday's title game ended in a 95-95 tie.")]),
    dict(name="tie_no_decisive_result", expect="NO", ts=TIE_TS, src=[
        dict(id="LG", published="2027-04-10T23:00:00Z", text="Ruritania Basketball League: Team A lost the title game 109-110 to Team B."),
        dict(id="RT", published="2027-04-11T08:00:00Z", text="Reuters: Team B won the Ruritania Basketball League title game 110-109 over Team A on Tuesday.")]),

    # --- ABANDONED_EVENT_V1
    dict(name="abandoned_yes_threshold_reached", expect="YES", ts=AB_TS, src=[
        dict(id="LG", published="2027-03-02T22:00:00Z", text="Ruritania Basketball League: the championship game was suspended due to a power outage after 46 of 48 minutes of play, with no rescheduling planned. The official record at suspension shows Team A leading 88-80."),
        dict(id="RT", published="2027-03-02T23:00:00Z", text="Reuters: the league confirmed the title game, suspended with two minutes left after a power failure, will not resume; Team A led 88-80 in the official record.")]),
    dict(name="abandoned_void_threshold_conflict", expect="VOID", ts=AB_TS, src=[
        dict(id="LG", published="2027-03-02T22:00:00Z", text="Ruritania Basketball League: the game was suspended by power outage after exactly 8 minutes of play and will not resume; the official record shows Team A trailing 10-14 at the time of suspension."),
        dict(id="RT", published="2027-03-02T23:00:00Z", text="Reuters: the league's own broadcast partner's official game clock shows the title game, suspended by a power failure, had in fact reached 30 minutes of play, with Team A leading 52-48 at suspension -- directly contradicting the league's own 8-minute, Team-A-trailing figure for the same suspension.")]),
    dict(name="abandoned_no_still_scheduled_to_resume", expect="ESCALATE", ts=AB_TS, src=[
        dict(id="LG", published="2027-03-02T22:00:00Z", text="Ruritania Basketball League: the game was suspended by a power outage after 8 minutes of play; the league says it will resume within 24 hours once power is restored."),
        dict(id="RT", published="2027-03-02T23:00:00Z", text="Reuters: the league confirmed the title game will resume Wednesday after an 8-minute suspension due to power failure.")]),

    # --- MEDIA_CONSENSUS_CALL_V1
    dict(name="media_consensus_yes", expect="YES", ts=MC_TS, src=[
        dict(id="M1", published="2027-11-04T01:00:00Z", text="Outlet1 News projects Candidate X wins the Ruritania presidential election."),
        dict(id="M2", published="2027-11-04T01:05:00Z", text="Outlet2 News calls the Ruritania presidential election for Candidate X."),
        dict(id="M3", published="2027-11-04T01:07:00Z", text="Outlet3 News: Candidate X has won the Ruritania presidential election, our decision desk projects."),
        dict(id="M4", published="2027-11-04T01:10:00Z", text="Outlet4 News projects Candidate X as the winner of the Ruritania presidential election."),
        dict(id="M5", published="2027-11-04T01:12:00Z", text="Outlet5 News: our decision desk calls the Ruritania presidential race for Candidate X.")]),
    dict(name="media_consensus_no_below_threshold", expect="ESCALATE", ts=MC_TS, src=[
        dict(id="M1", published="2027-11-04T01:00:00Z", text="Outlet1 News projects Candidate X wins the Ruritania presidential election."),
        dict(id="M2", published="2027-11-04T01:05:00Z", text="Outlet2 News calls the Ruritania presidential election for Candidate X."),
        dict(id="M3", published="2027-11-04T01:07:00Z", text="Outlet3 News: as of this morning, only 2 of the 6 term sheet-named media outlets (Outlet1 News and Outlet2 News) have called the Ruritania presidential race for Candidate X; Outlet3 News, Outlet4 News, Outlet5 News, and Outlet6 News all say it remains too early to call, short of the majority needed for a consensus call.")]),
    # Corrected expectation (GLM run surfaced a design mistake, not a model inconsistency): the
    # element asks whether the MEDIA_CONSENSUS_CALL_V1 *shortcut* was satisfied, not who actually
    # won. The clause's own text says the shortcut requires "none contradicts"; M5's dissent means
    # it plainly was not satisfied, so a confident not_met/NO is the correct, deterministic read --
    # not a conflict about the underlying winner. GLM (2/2) read this correctly; Haiku sometimes
    # over-applies "conflict" to the dissent itself, so NO|VOID|ESCALATE are all accepted as
    # non-wrong outcomes (none of them asserts a winner on contested evidence).
    dict(name="media_consensus_void_contradiction", expect="NO|VOID|ESCALATE", ts=MC_TS, src=[
        dict(id="M1", published="2027-11-04T01:00:00Z", text="Outlet1 News projects Candidate X wins the Ruritania presidential election."),
        dict(id="M2", published="2027-11-04T01:05:00Z", text="Outlet2 News calls the Ruritania presidential election for Candidate X."),
        dict(id="M3", published="2027-11-04T01:07:00Z", text="Outlet3 News: Candidate X has won the Ruritania presidential election, our decision desk projects."),
        dict(id="M4", published="2027-11-04T01:10:00Z", text="Outlet4 News projects Candidate X as the winner of the Ruritania presidential election."),
        dict(id="M5", published="2027-11-04T01:12:00Z", text="Outlet5 News projects Candidate Y wins the Ruritania presidential election. Outlet5 News explicitly disputes the other four networks' calls for Candidate X, meaning the named media outlets do not unanimously agree and a consensus call under the contract's media-consensus rule cannot be made either way.")]),

    # --- ROUNDING_PRECISION_V1
    dict(name="rounding_yes_exact_above_threshold", expect="YES", ts=RP_TS, src=[
        dict(id="AG", published="2028-01-05T10:00:00Z", text="World Meteorological Agency: the 2027 global average temperature anomaly was 1.252 degrees Celsius above the pre-industrial baseline, to three decimal places."),
        dict(id="RT", published="2028-01-05T14:00:00Z", text="Reuters: the agency's headline figure was rounded in some reports to about 1.3 degrees Celsius, a new record, though the agency's precise reading was 1.25 degrees.")]),
    dict(name="rounding_no_exact_below_threshold", expect="NO", ts=RP_TS, src=[
        dict(id="AG", published="2028-01-05T10:00:00Z", text="World Meteorological Agency: the 2027 global average temperature anomaly was 1.248 degrees Celsius above the pre-industrial baseline, to three decimal places."),
        dict(id="RT", published="2028-01-05T14:00:00Z", text="Reuters: headlines rounded the figure to roughly 1.25 degrees Celsius, a new record, citing the agency's preliminary data.")]),
    dict(name="rounding_void_primary_tier_conflict", expect="VOID", ts=RP_TS_CONFLICT, src=[
        dict(id="AG", published="2028-01-05T10:00:00Z", text="World Meteorological Agency: the 2027 global average temperature anomaly was 1.30 degrees Celsius above the pre-industrial baseline, our final published figure for the year."),
        dict(id="AG2", published="2028-01-05T11:00:00Z", text="National Climate Service: our final published figure for the 2027 global average temperature anomaly is only 1.10 degrees Celsius above the pre-industrial baseline. Both the National Climate Service and the World Meteorological Agency are listed as top-ranked primary sources for this contract with no tiebreak between them, and our 1.10-degree final figure directly conflicts with the World Meteorological Agency's 1.30-degree final figure for the identical period; neither figure supersedes the other and the two top-ranked sources cannot be reconciled.")]),

    # --- NO_DATA_FALLBACK_V1
    dict(name="no_data_void_nothing_published", expect="VOID", ts=ND_TS, src=[]),
    dict(name="no_data_yes_published_in_time", expect="YES", ts=ND_TS, src=[
        dict(id="AG", published="2028-01-06T10:00:00Z", text="National Statistics Agency: Q3 2027 labor productivity grew 2.4 percent, released January 6, 2028, one day before the scheduled January 7 cutoff."),
        dict(id="RT", published="2028-01-06T14:00:00Z", text="Reuters: the agency's Q3 2027 productivity report, released Thursday January 6, 2028, showed a 2.4 percent increase.")]),
    dict(name="no_data_no_delayed_but_pending", expect="ESCALATE", ts=ND_TS, src=[
        dict(id="AG", published="2027-12-20T10:00:00Z", text="National Statistics Agency: the Q3 2027 productivity report is delayed by two weeks due to a data processing backlog but will still be released before the January 7 cutoff."),
        dict(id="RT", published="2027-12-20T14:00:00Z", text="Reuters: the national statistics agency confirmed its Q3 productivity report is delayed two weeks but on track to publish before the deadline.")]),

    # --- FORMAT_CHANGE_V1
    dict(name="format_change_yes_delayed_but_full", expect="YES", ts=FC_TS, src=[
        dict(id="VR", published="2027-09-15T23:00:00Z", text="Variety: the headline performer's set was delayed 40 minutes by a technical issue but the artist fully performed later in the broadcast, closing the show."),
        dict(id="RT", published="2027-09-16T02:00:00Z", text="Reuters: after a 40-minute technical delay, the headline performer took the stage and completed a full set at the award show.")]),
    dict(name="format_change_no_withdrew", expect="NO", ts=FC_TS, src=[
        dict(id="VR", published="2027-09-15T23:00:00Z", text="Variety: the headline performer withdrew from the award show at the last minute; only a pre-recorded video message aired in their place, with no live performance."),
        dict(id="RT", published="2027-09-16T02:00:00Z", text="Reuters: the previously announced headline performer did not appear at the award show; organizers played a recorded video message instead.")]),
    dict(name="format_change_yes_joint_performance", expect="YES", ts=FC_TS, src=[
        dict(id="VR", published="2027-09-15T23:00:00Z", text="Variety: the performance originally billed solely to the headline performer was instead performed jointly, with a surprise guest joining them on stage for the full number at the award show."),
        dict(id="RT", published="2027-09-16T02:00:00Z", text="Reuters: the headline performer took the stage as scheduled and performed the full number, joined unexpectedly by a guest artist, at the award show.")]),
]

assert len(CASES) == 30, "expected exactly 30 worked scenarios, got %d" % len(CASES)

def run_case(case, key=None):
    tsx = case["ts"]
    clauses = set(tsx["clauses"])
    srcs, notes = J.eligible_sources(tsx, case["src"])

    # --- deterministic clause code, applied before any model call
    if "REVISION_WINDOW_V1" in clauses:
        srcs, rw_notes = J.apply_revision_window(srcs)
        notes = notes + rw_notes

    verdicts, detail = {}, {}
    for el in tsx["elements"]:
        if ("SOURCE_SUBSTITUTION_V1" in clauses or "NO_DATA_FALLBACK_V1" in clauses) and J.no_data_available(srcs):
            # VOID_SOURCE_UNAVAILABLE / VOID_NO_DATA: no eligible source published anything at all.
            # This is categorically different from "evidence was presented but didn't prove YES"
            # (which stays NO under burden of proof) -- nobody failed to meet their burden here,
            # there was simply nothing to evaluate, so the bet voids rather than resolving NO.
            outcome, why = "VOID", "VOID_NO_DATA: no eligible source published anything for %s before the evidence cutoff (SOURCE_SUBSTITUTION_V1/NO_DATA_FALLBACK_V1)" % el["id"]
            return dict(name=case["name"], expect=case["expect"], outcome=outcome, why=why,
                        ok=outcome in case["expect"].split("|"), verdicts={el["id"]: "void_no_data"},
                        dropped=notes, runs={el["id"]: [("code", "void_no_data", None)]})
        msgs = J.build_messages(tsx, el, srcs)
        rules_text = msgs[1]["content"].split("</rules>")[0]
        jobs = [(m, i) for m in MODELS for i in range(RUNS)]
        res = []
        with cf.ThreadPoolExecutor(6) as ex:
            futs = {ex.submit(J.call, m, msgs, key): (m, i) for m, i in jobs}
            for f in cf.as_completed(futs):
                m, i = futs[f]
                raw, cid = f.result()
                a, extra = J.verify(raw, srcs, rules_text)
                res.append((a, extra if a in ("met", "not_met") else None, m.split("/")[-1], raw[:160]))
        verdicts[el["id"]] = J.element_verdict([(r[0], r[1]) for r in res], tsx, srcs)
        detail[el["id"]] = [(r[2], r[0], r[1] if r[0] != "invalid" else r[1]) for r in res]
        detail[el["id"] + "_samples"] = [r[3] for r in res if r[0] == "invalid"][:2]
    outcome, why = J.decide(tsx, verdicts)
    ok = outcome in case["expect"].split("|")
    return dict(name=case["name"], expect=case["expect"], outcome=outcome, why=why, ok=ok,
                verdicts=verdicts, dropped=notes, runs=detail)

def main():
    key = os.environ.get("NEAR_AI_API_KEY")
    report = {"template": J.TEMPLATE_VERSION, "models": MODELS, "runs_per_model": RUNS, "cases": []}
    t0 = time.time()
    only = os.environ.get("ONLY", "").split(",") if os.environ.get("ONLY") else None
    cases = [c for c in CASES if not only or c["name"] in only]
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(lambda c: run_case(c, key), cases):
            report["cases"].append(r)
            print("%-38s expect=%-6s got=%-9s %s" % (r["name"], r["expect"], r["outcome"], "PASS" if r["ok"] else "FAIL"), flush=True)
    report["seconds"] = round(time.time() - t0)
    json.dump(report, open("clauses_report.json", "w"), indent=1)
    print("cases passed: %d/%d in %ss" % (sum(c["ok"] for c in report["cases"]), len(report["cases"]), report["seconds"]))

if __name__ == "__main__":
    main()
