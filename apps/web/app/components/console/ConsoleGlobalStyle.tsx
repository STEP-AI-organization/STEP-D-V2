"use client";

/* Global CSS for the console: body reset, scrollbar, selection, keyframes, and
 * the reusable :hover utility classes that replace the HTML's `style-hover`.
 * Ported/extended from the original GlobalStyle() block in page.tsx. */
const CSS = `
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:#F6F7F9;}
body{font-family:'Pretendard Variable',Pretendard,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;}
::-webkit-scrollbar{width:10px;height:10px;}
::-webkit-scrollbar-thumb{background:#E3E6EB;border-radius:8px;border:3px solid #F6F7F9;}
::-webkit-scrollbar-track{background:transparent;}
::selection{background:#E0DAFB;color:#16181D;}
@keyframes scrimIn{from{opacity:0}to{opacity:1}}
@keyframes scFade{from{opacity:0}to{opacity:1}}
@keyframes scPop{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}
input,textarea,button{font-family:inherit;}
textarea{resize:none;}
input[type=range]{accent-color:#6C5CE7;}

/* hover utilities (replace style-hover) */
.hv-row{transition:background .12s;}
.hv-row:hover{background:#FAFAFB;}
.hv-soft{transition:background .12s;}
.hv-soft:hover{background:#F4F5F7;}
.hv-card{transition:box-shadow .15s,border-color .15s;}
.hv-card:hover{border-color:#D5D9DF;box-shadow:0 6px 20px rgba(16,18,24,.07);}
.hv-violet{transition:border-color .15s,background .15s;}
.hv-violet:hover{border-color:#6C5CE7;background:#FBFAFF;}
.hv-edit{transition:border-color .15s,color .15s;}
.hv-edit:hover{border-color:#6C5CE7;color:#6C5CE7;}
.hv-btn-primary{transition:background .15s;}
.hv-btn-primary:hover{background:#5B4BD6;}
.hv-nav:hover{background:#F4F5F7;}
.hv-cyan:hover{border-color:#22C3E0;}
.hv-darklink{transition:color .12s;}
.hv-darklink:hover{color:#16181D;}
`;

export function ConsoleGlobalStyle() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
