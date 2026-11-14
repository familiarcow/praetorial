s=open('1b_clear2.mjs').read().replace('const betId = 1;','const betId = 2;').replace('16c2_','16c3_').replace('step16c2_','step16c3_').replace('mk("../live-run16c/results.json")','mk("../live-run16c/results_try2.json")')
open('1c_clear_bet2.mjs','w').write(s)
