import json
t = {
 "_comment": "R3c: KNYC 2026-11-05 daily high >= 70F (known answer 72F -> YES). Term sheet for the D-JUDGE4 live run.",
 "claim": "The NWS Climatological Report (Daily) for Central Park NY (KNYC) for 2026-11-05 shows a maximum temperature of at least 70 degrees Fahrenheit.",
 "elements": [{"id": "e1", "q": "Does the NWS Climatological Report (Daily) for Central Park NY (KNYC) show a maximum temperature of 70 F or higher for 2026-11-05?"}],
 "rule": "ALL",
 "clauses": ["UTC_V1", "NUMERIC_EXACT_V1", "NO_DATA_FALLBACK_V1", "CORRECTED_V1"],
 "custom_definitions": [
  "The deciding figure is the MAXIMUM temperature (F) for the calendar day 2026-11-05 in the final CLI report for KNYC, the report issued on 2026-11-06 at 145 AM EST where 2026-11-05 is YESTERDAY. A preliminary same-day report (TODAY, valid as of an afternoon time) is not final.",
  "The two sources are two independent copies of the NWS CLI product CLINYC: the NWS forecast office page (weather.gov) and the Iowa Environmental Mesonet archive of the same product. If they disagree on the maximum the sources conflict.",
  "Early resolution: YES may be declared as soon as the final report is published; NO only from the final report.",
  "Fallback: if one named source is unreachable, the other named source alone may decide; if neither can be read the outcome is VOID with full refunds.",
  "Burden of proof is on YES: a figure that is not shown in the final report resolves NO."
 ],
 "time": {"window_start": "2026-11-05T05:00:00Z", "window_end": "2026-11-06T04:59:59Z", "evidence_cutoff": "2026-11-06T12:00:00Z"},
 "sources_allowed": [
  {"id": "S_NWS", "publisher": "NWS weather.gov CLI KNYC", "url": "https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC&version=2&glossary=0"},
  {"id": "S_IEM", "publisher": "IEM nwstext CLI KNYC", "url": "https://mesonet.agron.iastate.edu/api/1/nwstext/202611060645-KOKX-CDUS41-CLINYC"}
 ],
 "source_classes": {"NWS weather.gov CLI KNYC": "primary", "IEM nwstext CLI KNYC": "primary"},
 "window_close": "2026-11-06T12:00:00Z",
 "sources": True
}
json.dump(t, open("terms.json", "w"), indent=1)
print(len(json.dumps(t)))
