import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import sharp from "sharp";
import { expect, test } from "@playwright/test";
import { renderTextOverlay, textOverlaySettingsSchema } from "../../src/lib/text-overlay/render";

test('generated image text can be replaced, dragged, resized, saved and reopened', async ({page}) => {
  const errors:string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const bytes = await sharp({create:{width:600,height:800,channels:3,background:'#97877b'}}).png().toBuffer();
  let document = {sourceAssetId:'sample',text:'A calmer day',settings:textOverlaySettingsSchema.parse({fontSize:34})};
  let result = await renderTextOverlay(bytes,document.text,document.settings);
  let saves = 0;
  await page.route('https://scenelith.test/api/assets/**', async route => {
    if(route.request().url().includes('/text-overlay')) {
      if(route.request().method() === 'GET') return route.fulfill({json:document});
      const body = route.request().postDataJSON();
      const rendered = await renderTextOverlay(bytes,body.text,{...body.settings,transparent:true});
      if(body.mode === 'preview') {
        const [left,top,right,bottom] = rendered.layout.bounds;
        const crop = await sharp(rendered.overlay!).extract({left,top,width:right-left,height:bottom-top}).png().toBuffer();
        return route.fulfill({json:{url:`data:image/png;base64,${crop.toString('base64')}`,width:600,height:800,bounds:rendered.layout.bounds}});
      }
      document = {sourceAssetId:'sample',text:body.text,settings:body.settings}; result=rendered; saves++;
      return route.fulfill({json:{assetId:`saved-${saves}`,url:`/api/assets/saved-${saves}`}});
    }
    return route.fulfill({contentType:'image/png',body:route.request().url().includes('/sample') ? bytes : result.image});
  });
  await page.route('https://scenelith.test/', route => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  const fixture = (await build({entryPoints:['tests/browser/fixtures/editable-image-text.tsx'],absWorkingDir:process.cwd(),tsconfig:path.resolve('tsconfig.json'),bundle:true,write:false,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('https://scenelith.test/');
  await page.addStyleTag({content:readFileSync('src/app/globals.css','utf8')+readFileSync('src/app/theme.css','utf8')});
  await page.addScriptTag({content:fixture});
  await page.getByRole('button',{name:'Text overlay',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Overlay text'})).toHaveValue('A calmer day');
  await page.getByRole('textbox',{name:'Overlay text'}).fill('My own words');
  await page.getByRole('button',{name:'Apply text',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Text overlay',exact:true})).toHaveCount(0);
  expect(document.text).toBe('My own words');
  await page.getByRole('button',{name:'Edit image',exact:true}).click();
  const layer = page.getByRole('button',{name:'Move overlay text'});
  await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down(); await page.mouse.move(box.x+box.width/2+20,box.y+box.height/2+65,{steps:5}); await page.mouse.up();
  await page.getByRole('slider',{name:'Text size',exact:true}).focus();
  for(let i=0;i<5;i++) await page.getByRole('slider',{name:'Text size',exact:true}).press('ArrowRight');
  await expect(page.getByRole('button',{name:'Apply text',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Apply text',exact:true}).click();
  await expect(page.getByRole('button',{name:'Close preview'})).toBeEnabled();
  expect(document.settings.y).toBeGreaterThan(50);
  expect(document.settings.sizeScale).toBe(1.25);
  await page.getByRole('button',{name:'Close preview'}).click();
  await page.getByRole('button',{name:'Edit image',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Overlay text'})).toHaveValue('My own words');
  await expect(page.getByRole('slider',{name:'Text size',exact:true})).toHaveValue('1.25');
  await expect(layer).toBeVisible();
  await page.screenshot({path:'/tmp/editable-image-text-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('textbox',{name:'Overlay text'})).toBeVisible();
  const textBox = (await page.getByRole('textbox',{name:'Overlay text'}).boundingBox())!;
  expect(textBox.x+textBox.width).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});
