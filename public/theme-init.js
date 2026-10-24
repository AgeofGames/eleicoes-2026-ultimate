'use strict';
(()=>{
 const key='eleicoes-2026-ultimate-theme';
 const media=window.matchMedia('(prefers-color-scheme: dark)');
 let preference=null;
 try{const stored=localStorage.getItem(key);if(stored==='dark'||stored==='light')preference=stored;}catch(error){}
 function apply(theme){document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#101722':'#f5f6f8';window.dispatchEvent(new Event('election-theme-change'));}
 apply(preference||(media.matches?'dark':'light'));
 media.addEventListener('change',event=>{if(!preference)apply(event.matches?'dark':'light');});
 window.addEventListener('storage',event=>{if(event.key===key){preference=event.newValue==='dark'||event.newValue==='light'?event.newValue:null;apply(preference||(media.matches?'dark':'light'));}});
 window.electionTheme={set(theme){if(theme!=='dark'&&theme!=='light')return;preference=theme;try{localStorage.setItem(key,theme);}catch(error){}apply(theme);}};
})();
