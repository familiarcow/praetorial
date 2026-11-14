import json
a=json.load(open('results.json')); b=json.load(open('results_try2.json'))
for n,r in (('results',a),('try2',b)):
    print('==',n)
    for t in r['txs']: print(t['step'],t['hash'],t.get('status'))
