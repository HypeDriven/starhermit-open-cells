// probe journey grid + stage setup + start
(function(){
  function waitFor(fn, label, timeoutMs){return new Promise(function(res,rej){var t0=Date.now();(function p(){var v;try{v=fn();}catch(e){}if(v)return res(v);if(Date.now()-t0>(timeoutMs||8000))return rej(new Error('timeout '+label));setTimeout(p,60);})();});}
  function clickEl(n){n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));}
  waitFor(function(){return window.__ocApp && window.__ocApp.ui;},'boot').then(function(){
    var app = window.__ocApp;
    app.ui.closeAll();
    app.ui.showJourney({journey: app.save.journey});
    return waitFor(function(){return document.querySelector('.journey-grid');},'journey grid').then(function(){
      var cells = document.querySelectorAll('.journey-cell');
      console.log('journey cells:', cells.length, 'first disabled?', cells[0].disabled, 'second disabled?', cells[1].disabled);
      clickEl(cells[0]);
      return waitFor(function(){return document.querySelector('.screen-overlay[data-screen="stage-setup"]');},'stage setup');
    }).then(function(){
      var start = Array.from(document.querySelectorAll('.screen-overlay[data-screen="stage-setup"] button')).find(function(b){return /begin/i.test(b.textContent);});
      clickEl(start);
      return waitFor(function(){return app.session && app.config.mode==='journey';},'journey session');
    }).then(function(){
      console.log('journey session started:', app.config.dealId, 'seed', app.session.state.seed);
      console.log('PROBE PASS');
    });
  }).catch(function(e){ console.log('PROBE FAIL', String(e)); });
})();
