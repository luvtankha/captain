// Diagnostic-only metrics shared with Node regression tests. Never production policy.
(function(root) {
  function distance(a,b) {
    let row=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=0;i<a.length;i++) {
      const next=[i+1];
      for(let j=0;j<b.length;j++) next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]===b[j]?0:1)));
      row=next;
    }
    return row[b.length];
  }
  function recognition(reference,observed) {
    const normalize=s=>s.trim().replace(/\s+/g,' ');
    const expected=normalize(reference),actual=normalize(observed);
    if(!expected)throw Error('Reference must not be empty');
    return {characterErrors:distance([...expected],[...actual]),characters:[...expected].length,
      wordErrors:distance(expected.split(' '),actual?actual.split(' '):[]),words:expected.split(' ').length};
  }
  root.CaptainReadinessMetrics=Object.freeze({distance,recognition});
})(globalThis);
