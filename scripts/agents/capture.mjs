import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const input=JSON.parse(await readFile('/input/capture.json','utf8'));
const preview=process.argv[2]==='preview';
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block',...(preview?{}:{recordVideo:{dir:'/out/video',size:{width:1280,height:720}}})});
const allowed=input.url ? new URL(input.url).origin : null;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if (['data:','blob:','about:'].includes(url.protocol) || url.origin===allowed) await route.continue(); else await route.abort('blockedbyclient');
});
const page=await context.newPage();
page.setDefaultTimeout(6000);
const started=Date.now();
const result={status:'succeeded',actions:[],errors:[],video:null,mode:input.mode || 'scripted'};
page.on('pageerror',error=>{if(result.errors.length<20) result.errors.push({kind:'page',positionMs:Date.now()-started,message:error.message.trim().slice(0,1000)||'Application reported an empty page error'});});
page.on('console',message=>{if(message.type()==='error'&&result.errors.length<20) result.errors.push({kind:'console',positionMs:Date.now()-started,message:message.text().trim().slice(0,1000)||'Application emitted console.error without a message'});});
page.on('response',response=>{if(response.status()>=500&&result.errors.length<20) result.errors.push({kind:'http',positionMs:Date.now()-started,message:`Application returned HTTP ${response.status()}`});});
const escape=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function card(title,lines,label) {
  await page.goto('about:blank');
  await page.setContent(`<html lang="en"><meta charset="utf-8"><style>body{margin:0;background:#f7f8fc;color:#18243c;font:28px system-ui}main{padding:72px 90px;border-left:14px solid #3e5bfa;height:576px}small{font-size:20px;color:#53617c}h1{font-size:47px;line-height:1.15;margin:25px 0 35px}li{margin:18px 0;line-height:1.3}ul{padding-left:28px}</style><main><small>${escape(label)}</small><h1>${escape(title)}</h1><ul>${lines.map(line=>`<li>${escape(String(line).slice(0,200))}</li>`).join('')}</ul></main></html>`);
  await page.waitForTimeout(3000);
}
try {
  if (preview) {
    await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:30_000});
    await writeFile('/out/preview.json',JSON.stringify({dom:(await page.locator('body').ariaSnapshot()).slice(0,24_000)}));
    await page.screenshot({path:'/out/preview.png'});
  } else {
    for (const item of input.cards || []) await card(item.title,item.lines,item.label);
    if (input.failure) {result.status='failed';result.error=String(input.failure).slice(0,1000);}
    if (input.url) {
      await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:30_000});
      await page.waitForTimeout(1000);
      for (const action of input.actions || []) {
        const receipt={kind:action.kind,status:'succeeded',positionMs:Date.now()-started,description:action.kind==='click'?`Activate ${action.role} "${action.name}"`:action.kind==='fill'?`Fill "${action.label}"`:`Check "${action.text}"`};
        try {
          if (action.kind==='click') await page.getByRole(action.role,{name:action.name,exact:true}).click();
          else if(action.kind==='fill') {
            const field=page.getByLabel(action.label,{exact:true});
            if ((await field.getAttribute('type'))==='password') throw new Error('Credential entry is excluded from the isolated demo profile. Use synthetic local demo data');
            await field.fill(action.value);
          } else if(action.kind==='assert') {const found=page.getByText(action.text,{exact:false}).first();await found.waitFor({state:'visible'});receipt.observedText=(await found.innerText()).trim().slice(0,2000);}
          else throw new Error('Unsupported bounded demo action');
          await page.waitForTimeout(850);
        } catch(error) {receipt.status='failed';receipt.description=`${receipt.description} failed. ${error.message.split('\n')[0].slice(0,500)}`;result.status='failed';result.error=receipt.description;}
        result.actions.push(receipt);
        await page.screenshot({path:`/out/action-${result.actions.length}.png`});
        if(receipt.status==='failed') {await page.waitForTimeout(2500);break;}
      }
    }
    if (result.errors.length) result.status='failed';
    if (result.status==='failed'&&input.audience==='internal') await card('This demo found a failure',[result.error || result.errors[0]?.message || 'The application did not complete the recorded check.'],'INTERNAL · OBSERVED FAILURE');
    else if(input.url) await card('End of demo',[input.audience==='customer'?'Private draft. Review before sharing.':'The recorded checks completed.'],'RECORDED OBSERVATIONS');
  }
} catch(error) {result.status='failed';result.error=error.message.split('\n')[0].slice(0,1000);await page.screenshot({path:'/out/failure.png'}).catch(()=>{});}
finally {
  const video=page.video();
  await context.close();await browser.close();
  if (!preview) result.video=await video.path();
  if (!preview) await writeFile('/out/capture-result.json',JSON.stringify(result));
}
if(preview&&result.status==='failed') throw new Error(result.error);
