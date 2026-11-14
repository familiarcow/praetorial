# R2 progress / budget (final snapshot; the ~100-case budget check was superseded by Addendum 2)
- NEAR AI spend (our meter, `spend.jsonl`, 5,039 calls, 0 HTTP 429 logged, no credit errors): **$14.75**. ≈$10.9 was spent before Addendum 2 (4 models x 3 reps on lanes A/B and part of C; kept, used for the comparison section only). Addendum-2 pair runs + 3 improvement rounds ≈ $3.8.
- Projection that was made at the 100-case mark: the original plan (4 models x N=3 on all ~600 cases) would have cost ≈$40–60 because lane C with the large model (glm-5.3, $0.05/call) dominated; the focused design replaced it.
- Credits: never exhausted. Shared-key 429s: the runner backs off 4–24 s and retries up to 4 times and never records a 429 as a model failure (`analyze2.py` drops them).
