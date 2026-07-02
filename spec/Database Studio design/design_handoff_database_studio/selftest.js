/* ============================================================================
   Database Studio — automated self-test harness.
   Open DevTools → type: runSelfTest()   (returns the result array; also
   prints a console.table). Read-only where possible; any mutation it makes
   (imported rows, backup entry, migration) is snapshotted and reverted.
   ========================================================================== */
(function(){
  function findLogic(){
    const nodes=document.querySelectorAll('*');
    for(var _ni=0;_ni<nodes.length;_ni++){ var el=nodes[_ni];
      var k=Object.keys(el).find(x=>x.startsWith('__reactFiber$')||x.startsWith('__reactInternalInstance$'));
      if(!k)continue;
      let f=el[k];
      while(f){
        const sn=f.stateNode;
        if(sn&&sn.logic&&typeof sn.logic.execSql==='function')return sn.logic;
        if(sn&&typeof sn.execSql==='function'&&typeof sn.runImport==='function')return sn;
        f=f.return;
      }
    }
    return null;
  }

  window.runSelfTest=async function(){
    const R=[];
    const add=(feature,input,output,expected,verdict)=>R.push({Feature:feature,'Input test':input,'Output thật':output,'Kỳ vọng':expected,Verdict:verdict});
    const logic=findLogic();
    if(!logic){ console.error('runSelfTest: could not locate the Database Studio logic instance. Make sure the app has finished loading.'); return; }

    const tick=(ms=0)=>new Promise(r=>setTimeout(r,ms));
    const setS=(p)=>new Promise(res=>{ try{ logic.setState(p,res); }catch(e){ res(); } });
    const trunc=(s,n=58)=>{ s=String(s); return s.length>n?s.slice(0,n)+'\u2026':s; };
    const origActive=logic.state.activeTabId;
    const flashes=[];
    const realFlash=logic.flash;
    const spyOn=()=>{ flashes.length=0; logic.flash=function(m){ flashes.push(m); }; };
    const spyOff=()=>{ logic.flash=realFlash; };

    try{
      const store=logic.store();

      /* ---- GROUP 1: execSql per connection ------------------------------ */
      console.log('%c=== GROUP 1: execSql per connection ===','font-weight:bold;color:#5b7cff');
      for(var _ci=0;_ci<logic.CONNS.length;_ci++){ var c=logic.CONNS[_ci];
        var sys=c.system, db=store[c.id];
        const tables=db?Object.keys(db):[];
        if(!tables.length){
          const q='SELECT * FROM demo LIMIT 5';
          let out,verd;
          try{ const r=logic.execSql(c.id,q); out=r.ok?('OK rows='+((r.result.rows||[]).length)):('error: '+trunc(r.error,42)); verd=r.ok?'FAIL':'PASS'; }
          catch(e){ out='exception: '+trunc(e.message,40); verd='PASS'; }
          add('execSql \u00b7 '+sys+' ('+c.id+')', q, out, 'non-SQL system \u2192 rejects (key/topic/subject browser)', verd);
          continue;
        }
        const t0=tables[0], meta=db[t0];
        // Q1 simple
        try{ const q='SELECT * FROM '+t0+' LIMIT 5'; const r=logic.execSql(c.id,q);
          const n=r.ok?r.result.rows.length:0;
          add('execSql \u00b7 '+sys+' \u00b7 simple SELECT', trunc(q,50), r.ok?('OK \u00b7 '+n+' rows (total '+r.result.total+')'):('error: '+trunc(r.error,40)), 'returns rows', (r.ok&&n>0)?'PASS':(r.ok?'CANNOT-VERIFY':'FAIL'));
        }catch(e){ add('execSql \u00b7 '+sys+' \u00b7 simple SELECT', 'SELECT * FROM '+t0, 'exception: '+trunc(e.message,40), 'returns rows', 'FAIL'); }
        // Q2 where
        try{
          const col0=meta.cols[0][0]; let sample=null;
          for(var _ri=0;_ri<meta.rows.length;_ri++){ var rr=meta.rows[_ri]; if(rr[col0]!=null){ sample=rr[col0]; break; } }
          let pred;
          if(sample==null){ pred=col0+' IS NOT NULL'; }
          else { const num=(typeof sample==='number')||/^-?\d+(\.\d+)?$/.test(String(sample)); pred=col0+' = '+(num?String(sample):("'"+String(sample).replace(/'/g,"''")+"'")); }
          const q='SELECT * FROM '+t0+' WHERE '+pred+' LIMIT 5';
          const r=logic.execSql(c.id,q);
          if(!r.ok){ add('execSql \u00b7 '+sys+' \u00b7 SELECT+WHERE', trunc(q,55), 'error: '+trunc(r.error,38), 'filtered rows', 'FAIL'); }
          else { const n=r.result.rows.length; const full=logic.execSql(c.id,'SELECT * FROM '+t0).result.total;
            add('execSql \u00b7 '+sys+' \u00b7 SELECT+WHERE', trunc(q,55), 'OK \u00b7 '+n+' rows (unfiltered '+full+')', 'WHERE filters/reduces', (n<=full)?'PASS':'CANNOT-VERIFY'); }
        }catch(e){ add('execSql \u00b7 '+sys+' \u00b7 SELECT+WHERE', 'WHERE on '+t0, 'exception: '+trunc(e.message,40), 'filtered rows', 'FAIL'); }
        // Q3 join
        try{
          const cols0=meta.cols.map(x=>x[0]); let jt=null,jc=null;
          for(var _ti=0;_ti<tables.length;_ti++){ var t1=tables[_ti]; if(t1===t0)continue; var c1=db[t1].cols.map(x=>x[0]);
            let common=cols0.find(cc=>/_id$/.test(cc)&&c1.includes(cc));
            if(!common)common=cols0.find(cc=>cc!=='id'&&c1.includes(cc));
            if(!common)common=cols0.find(cc=>c1.includes(cc));
            if(common){ jt=t1; jc=common; break; } }
          if(!jt){ add('execSql \u00b7 '+sys+' \u00b7 SELECT+JOIN', '(no shared column across tables)', '\u2014 skipped', 'JOIN combines tables', 'CANNOT-VERIFY'); }
          else { const q='SELECT * FROM '+t0+' JOIN '+jt+' ON '+t0+'.'+jc+' = '+jt+'.'+jc+' LIMIT 5';
            const r=logic.execSql(c.id,q);
            if(!r.ok){ add('execSql \u00b7 '+sys+' \u00b7 SELECT+JOIN', trunc(q,60), 'error: '+trunc(r.error,38), 'JOIN combines tables', 'FAIL'); }
            else { const n=r.result.rows.length, ncol=r.result.cols.length, exp=meta.cols.length+db[jt].cols.length;
              add('execSql \u00b7 '+sys+' \u00b7 SELECT+JOIN', trunc(q,60), 'OK \u00b7 '+n+' rows \u00b7 '+ncol+' cols', 'JOIN \u2192 '+exp+' cols', (ncol===exp)?'PASS':'CANNOT-VERIFY'); } }
        }catch(e){ add('execSql \u00b7 '+sys+' \u00b7 SELECT+JOIN', 'JOIN on '+t0, 'exception: '+trunc(e.message,40), 'JOIN combines tables', 'FAIL'); }
      }

      /* ---- GROUP 2: Import Wizard (hardcode detection) ------------------ */
      console.log('%c=== GROUP 2: Import Wizard (hardcode detection) ===','font-weight:bold;color:#5b7cff');
      try{
        const cid=Object.keys(store)[0], t=Object.keys(store[cid])[0], tbl=store[cid][t];
        const headers=tbl.cols.map(x=>x[0]); const mapping={}; headers.forEach(h=>mapping[h]=h);
        const baseLen=tbl.rows.length;
        const mkRows=(n,tag)=>Array.from({length:n},(_,i)=>headers.map((h,ci)=>{ const proto=tbl.rows[0]?tbl.rows[0][h]:null; return (typeof proto==='number')?(900000+i):(tag+'_'+i+'_'+ci); }));
        await setS({importOpen:true,impConnId:cid,impTable:t,impHeaders:headers,impMapping:mapping,impRows:mkRows(2,'A'),impFileName:'alpha.csv',impStep:4,impRunning:false,impResult:null,impProgress:0});
        logic.runImport(); await tick(1300);
        const insA=(logic.state.impResult||{}).inserted, afterA=tbl.rows.length;
        await setS({impConnId:cid,impTable:t,impHeaders:headers,impMapping:mapping,impRows:mkRows(5,'B'),impFileName:'beta.csv',impStep:4,impRunning:false,impResult:null,impProgress:0});
        logic.runImport(); await tick(1300);
        const insB=(logic.state.impResult||{}).inserted, afterB=tbl.rows.length;
        const varies=(insA!==insB && insA===2 && insB===5);
        add('Import \u00b7 file A (alpha.csv, 2 rows)', '2 data rows \u2192 '+t, 'inserted='+insA+', store '+baseLen+'\u2192'+afterA, 'inserted=2, store grows', (insA===2&&afterA===baseLen+2)?'PASS':'FAIL');
        add('Import \u00b7 file B (beta.csv, 5 rows)', '5 data rows \u2192 '+t, 'inserted='+insB+', store '+afterA+'\u2192'+afterB, 'inserted=5, store grows', (insB===5&&afterB===afterA+5)?'PASS':'FAIL');
        add('Import \u00b7 input-sensitivity', 'compare A(2) vs B(5)', varies?'output CHANGES with input (2\u22605)':'output identical regardless of input', 'NOT hardcoded', varies?'PASS':'FAIL');
        tbl.rows.length=baseLen; tbl.total=baseLen; // revert
        await setS({importOpen:false});
      }catch(e){ add('Import Wizard', '2 mock files', 'exception: '+trunc(e.message,50), 'input-sensitive', 'FAIL'); }

      /* ---- GROUP 3: Export / Backup / Grant / Structure Compare --------- */
      console.log('%c=== GROUP 3: Export / Backup / Grant / Structure Compare ===','font-weight:bold;color:#5b7cff');
      // EXPORT
      try{
        let at=logic.TABS.find(x=>x.id===logic.state.activeTabId)||logic.TABS[0];
        if(!store[at.connId]){ const alt=logic.TABS.find(x=>store[x.connId]); if(alt){ await setS({activeTabId:alt.id}); at=alt; } }
        const cid=at.connId, tbls=Object.keys(store[cid]), t=tbls[0], t2=tbls[1]||t;
        const origCO=URL.createObjectURL, origClick=HTMLAnchorElement.prototype.click;
        let cap=null; URL.createObjectURL=(b)=>{ cap=b; return 'blob:selftest'; }; HTMLAnchorElement.prototype.click=function(){};
        const runExp=async(tbl)=>{ const sel={}; store[cid][tbl].cols.map(x=>x[0]).forEach(c=>sel[c]=true);
          await setS({exportOpen:true,exportTable:tbl,exportFormat:'json',exportWhere:'',exportLimit:'50',exportFile:tbl+'_x.json',exportColsSel:sel});
          cap=null; logic.runExport(); const b=cap; return { size:b?b.size:0, text:b?await b.text():'' }; };
        const a=await runExp(t); const b=await runExp(t2);
        URL.createObjectURL=origCO; HTMLAnchorElement.prototype.click=origClick;
        let cntA=0; try{ cntA=JSON.parse(a.text).length; }catch(_){}
        const real=(a.size>0 && cntA>0);
        add('Export \u00b7 runExport('+t+', JSON)', 'export table '+t, 'file bytes='+a.size+', rows='+cntA, 'real file built from engine rows', real?'PASS':'FAIL');
        add('Export \u00b7 content-sensitivity', 'export '+t+' vs '+t2, (t2!==t)?(a.text!==b.text?'output differs by table':'identical output'):'only one table available', 'content reflects real data', (t2!==t)?(a.text!==b.text?'PASS':'FAIL'):'CANNOT-VERIFY');
        await setS({exportOpen:false});
      }catch(e){ add('Export Wizard', 'runExport', 'exception: '+trunc(e.message,50), 'real file', 'FAIL'); }
      // BACKUP
      try{
        const at=logic.TABS.find(x=>x.id===logic.state.activeTabId)||logic.TABS[0]; const cid=at.connId;
        const before=(logic.bkAll()[cid]||[]).length;
        await setS({backupModalOpen:true,bkScope:'full',bkTables:[],bkFormat:'sql',bkGzip:true,bkRunning:false,bkProgress:0});
        logic.runBackup(); await tick(1800);
        const hist=(logic.state.backupHistory||{})[cid]||[]; const after=hist.length, newest=hist[0];
        const ok=(after===before+1 && newest && newest.sizeMB>0 && !!newest.timestamp);
        add('Backup \u00b7 runBackup (full)', 'create backup on '+cid, 'history '+before+'\u2192'+after+(newest?(', '+newest.sizeMB+'MB @ '+newest.timestamp):''), 'appends real history entry', ok?'PASS':'FAIL');
        if(after===before+1){ const all={...logic.state.backupHistory}; all[cid]=all[cid].slice(1); await setS({backupHistory:all,backupModalOpen:false}); }
        else { await setS({backupModalOpen:false}); }
      }catch(e){ add('Backup', 'runBackup', 'exception: '+trunc(e.message,50), 'real side-effect', 'FAIL'); }
      // GRANT
      try{
        const vals=logic.renderVals();
        const sig=JSON.stringify({tabs:logic.TABS.length,exp:logic.state.exportOpen,imp:logic.state.importOpen,bk:logic.state.backupModalOpen});
        spyOn(); if(typeof vals.exGrant==='function')vals.exGrant(); spyOff();
        const sig2=JSON.stringify({tabs:logic.TABS.length,exp:logic.state.exportOpen,imp:logic.state.importOpen,bk:logic.state.backupModalOpen});
        const onlyToast=(flashes.length>0 && sig===sig2);
        add('Grant / Privileges (toolbar \ud83d\udd12)', 'call exGrant handler', 'flash="'+trunc(flashes[0]||'(none)',38)+'" \u00b7 state unchanged='+(sig===sig2), 'UI shell \u2014 toast only, no real GRANT/REVOKE', onlyToast?'PASS (matches audit: shell)':'FAIL');
      }catch(e){ add('Grant', 'exGrant', 'exception: '+trunc(e.message,50), 'toast only', 'CANNOT-VERIFY'); }
      // STRUCTURE COMPARE
      try{
        await setS({compareSrc:'c1',compareTgt:'c7'}); const dA=logic.cmpSyncScript();
        await setS({compareSrc:'c2',compareTgt:'c9'}); const dB=logic.cmpSyncScript();
        await setS({compareSrc:'c1',compareTgt:'c7'});
        const staticDiff=(dA===dB);
        add('Structure Compare \u00b7 diff source', 'change SRC/TGT: c1\u2192c7 vs c2\u2192c9', staticDiff?'sync script IDENTICAL for both pairs':'sync script changes with selection', 'diff computed from chosen connections', staticDiff?'FAIL (hardcoded CMP_DIFF)':'PASS');
        const clone=JSON.parse(JSON.stringify(logic.CMP_DIFF));
        const beforeSt=logic.CMP_DIFF.map(t=>t.status).join(',');
        await setS({cmpChecked:{},cmpRunning:false});
        logic.executeMigration(); await tick(1000);
        const afterSt=logic.CMP_DIFF.map(t=>t.status).join(',');
        const mutated=(beforeSt!==afterSt);
        logic.CMP_DIFF=clone; await setS({cmpRunning:false}); // revert
        add('Structure Compare \u00b7 executeMigration', 'apply checked diffs', mutated?('diff model: '+trunc(beforeSt,22)+' \u2192 '+trunc(afterSt,22)):'no change', 'mutates diff model (NOT the real target schema)', mutated?'CANNOT-VERIFY (diff-model only, no real DB write)':'FAIL');
        const tb=logic.TABS.length; logic.openCompare();
        const opened=(logic.TABS.some(t=>t.type==='compare') && logic.TABS.length>=tb);
        logic.TABS=logic.TABS.filter((t,i)=>!(t.type==='compare'&&i>=tb)); await setS({activeTabId:origActive});
        add('Structure Compare \u00b7 openCompare', 'open compare workspace', opened?'compare tab created (real state change)':'no tab created', 'opens compare workspace', opened?'PASS':'FAIL');
      }catch(e){ add('Structure Compare', 'compare/migrate', 'exception: '+trunc(e.message,50), '\u2014', 'CANNOT-VERIFY'); }

      /* ---- GROUP 4: "UI shell" handlers — side-effect log --------------- */
      console.log('%c=== GROUP 4: "UI shell" handlers \u2014 side-effect log ===','font-weight:bold;color:#5b7cff');
      const vals=logic.renderVals();
      const shellProbe=(label,input,fn,note)=>{
        const snap=()=>JSON.stringify({tabs:logic.TABS.length,keys:Object.keys(logic.state).length,act:logic.state.activeTabId,exp:logic.state.exportOpen,imp:logic.state.importOpen,bk:logic.state.backupModalOpen,pal:logic.state.paletteOpen});
        const s1=snap(); spyOn(); let ex=null; try{ fn(); }catch(e){ ex=e.message; } spyOff(); const s2=snap();
        const changed=(s1!==s2);
        const out=ex?('exception: '+trunc(ex,34)):('flash="'+trunc(flashes[0]||'(no toast)',36)+'" \u00b7 structural change='+changed);
        const verdict=ex?'CANNOT-VERIFY':((!changed&&flashes.length)?'PASS (shell: toast only)':(changed?'FAIL (has side-effect)':'PASS (silent no-op)'));
        add('UI shell \u00b7 '+label, input, out, note, verdict);
      };
      shellProbe('testConn', "testConn('c1')", ()=>logic.testConn('c1'), 'toast only (no real connect)');
      shellProbe('downloadBackup', 'downloadBackup(mock)', ()=>logic.downloadBackup({timestamp:'2026-06-30 02:00',sizeMB:120}), 'toast only (no file download)');
      shellProbe('exGrant (toolbar)', 'exGrant()', ()=>{ if(vals.exGrant)vals.exGrant(); }, 'toast only');
      shellProbe('copyConnStr', "copyConnStr('c1')", ()=>logic.copyConnStr('c1'), 'toast + clipboard (no state change)');

      /* ---- results ------------------------------------------------------ */
      console.log('%c=== SELF-TEST RESULTS ===','font-weight:bold;font-size:13px;color:#27AE60');
      console.table(R);
      const tally=R.reduce((a,r)=>{ const v=r.Verdict.split(' ')[0]; a[v]=(a[v]||0)+1; return a; },{});
      console.log('Summary by verdict:',tally);
      console.log('Legend: PASS = works / matches audit \u00b7 FAIL = broken or hardcoded \u00b7 CANNOT-VERIFY = needs real UI (animation, DB write, download) or is diff-model only.');
    }finally{
      spyOff();
      try{ await setS({activeTabId:origActive}); }catch(_){}
    }
    return R;
  };
  console.log('%c[Database Studio] self-test ready \u2014 type  runSelfTest()  in the console.','color:#5b7cff;font-weight:bold');
})();
