import json
a=json.load(open('../live-RFRZ2/results.json'))['new_args']
o=a['outcome_pubkey'],a['attest_pubkey'],a['resolver_wasm_hash']
a['outcome_pubkey']='4479e0b6d288cbcc77324b916bfe8296bcd48cb764de87d134bd90584565ef23'
a['attest_pubkey']='a3fa8914a3c6eccd792660167d1e7e67fc06f4294521eadcc2b7a8f6c097f6ae'
a['resolver_wasm_hash']='8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473'
json.dump(a,open('new_args.json','w'),indent=2)
print('replaced',[x[:8] for x in o]); print([k for k in a])
