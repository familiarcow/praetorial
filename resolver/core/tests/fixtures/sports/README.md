# SP1 sports fixtures (raw bytes, untrimmed)
Fetched with curl (free public reads) on 2026-11-08T06:22:28Z-06:22:30Z, HTTP 200 each, using the URL shapes of `league_event_url`.
| file | URL | sha256 |
|---|---|---|
| mlb_schedule_20260402.json | https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-02 | 00989e57c22020beaca9e99214dee27d1bf5b14ec03ae29653b7a9a6bcad3469 |
| mlb_schedule_20260403.json | ...&date=2026-04-03 | 5745a5c0449af2efaa541a916e91bdbcad3b8b9601cd743ec8a7539a3e497085 |
| mlb_schedule_20260927.json | ...&date=2026-09-27 | c2b99c1405981a9392adc89ff7f1d407dd391d108f2aee35c953ff6e812bcd8b |
| mlb_schedule_20260404.json | ...&date=2026-04-04 | 618ef203145571bf7eb75ba6d8e8253fcfb10b021c3015e518df2be6f64e4e7c |
| espn_mlb_scoreboard_20260402.json | https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260402 | ed15a840af9739bc2cee07147ddf05fc3fafcf2c7c01fffe6ff128ec84dae878 |
| espn_mlb_scoreboard_20260403.json | ...dates=20260403 | 11532a448c8d9e4208ae63b45472441aa3ba7f1ec7473b2ca5c6b0f47d101da2 |
| espn_mlb_scoreboard_20260927.json | ...dates=20260927 | 5c89eb9d7a6ef13e41e8b6c34220923e1f7815d9f901bd6f2267de849fb3f142 |
| espn_mlb_scoreboard_20260404.json | ...dates=20260404 | e40995eec424947cc109b5ee1c41ed6c67ccb06622e1615374942ed3eb228b56 |
| nhl_score_20261105.json | https://api-web.nhle.com/v1/score/2026-11-05 | 8957add75aaf23b3a3172c2a1d77bf259c9eb7cec650fd47c4975d9cc3fba9c9 |
| espn_nhl_scoreboard_20261105.json | https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105 | e3c24351068904e74445da60f133b85f1638c6a5e49f7053609898648b26dabc |

Observed (matches the brief): 824621 on 04-02 = abstract Final / coded D Postponed (no scores, rescheduleGameDate 04-03); same gamePk on 04-03 = coded F Final CHW 5-4 TOR;
823490 (NYY/BAL) 09-27 = coded C Cancelled; 824295 (DET/STL) 04-04 = coded F "Completed Early" 11-6; NHL 2026020251 MTL 5-4 UTA OT, 2026020258 CBJ 2-1 DAL SO.
Note: ESPN's 04-02 / 09-27 / 04-04 scoreboards list the postponed/cancelled games as STATUS_POSTPONED / STATUS_CANCELED with score "0"-"0" (ESPN ids 401814780, 401817103);
ESPN's make-up game has its OWN id (401867263, Final/10, 04-03). Synthetic variants in tests/sports_sp1.rs are built in code from these real objects and are named `synthetic_*`.
