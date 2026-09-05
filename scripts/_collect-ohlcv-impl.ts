import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeAndWriteParquet } from "../server/orchestrator/storage.js";
const root=resolve(import.meta.dirname,"..");
const symbols=readFileSync(resolve(root,"config/universe.txt"),"utf8").split("\n").map(x=>x.trim()).filter(x=>x&&!x.startsWith("#"));
const token=process.env.MD_TOKEN; if(!token) throw new Error("MD_TOKEN not set");
const daily=process.argv.includes("--daily"), start=Math.max(0,Number(process.env.OHLCV_START_INDEX??0));
const from=process.env.OHLCV_FROM??`${new Date().getUTCFullYear()-7}-01-01`, today=new Date().toISOString().slice(0,10);
type Bar={date:string;open:number;high:number;low:number;close:number;volume:number};
const uri=(s:string)=>`s3://magpie-data/ohlcv/daily/${s}.parquet`;
async function write(s:string,rows:Bar[]){if(rows.length) await mergeAndWriteParquet({uri:uri(s),schema:"(date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",dedupKey:"date",rows,orderBy:"date"});}
function toBars(d:any):Bar[]{return d.s!=="ok"?[]:(d.t??[]).map((t:number,i:number)=>({date:new Date(t*1000).toISOString().slice(0,10),open:d.o?.[i]??0,high:d.h?.[i]??0,low:d.l?.[i]??0,close:d.c?.[i]??0,volume:d.v?.[i]??0}));}
async function get(u:string){const r=await fetch(u,{headers:{Authorization:`Token ${token}`}});if(!r.ok)throw new Error(`MarketData HTTP ${r.status}`);return r.json();}
async function backfill(s:string){await write(s,toBars(await get(`https://api.marketdata.app/v1/stocks/candles/D/${encodeURIComponent(s)}?from=${from}&to=${today}`)));}
async function refresh(chunk:string[]){const d=await get(`https://api.marketdata.app/v1/stocks/bulkcandles/D/?symbols=${encodeURIComponent(chunk.join(","))}`);if(d.s!=="ok")throw new Error("bulk candles returned no data");for(let i=0;i<(d.symbol??[]).length;i++){const s=d.symbol[i],t=d.t?.[i];if(s&&t)await write(s,[{date:new Date(t*1000).toISOString().slice(0,10),open:d.o?.[i]??0,high:d.h?.[i]??0,low:d.l?.[i]??0,close:d.c?.[i]??0,volume:d.v?.[i]??0}]);}}
if(daily){for(let i=0;i<symbols.length;i+=500){await refresh(symbols.slice(i,i+500));console.log(`${Math.min(i+500,symbols.length)}/${symbols.length}`);}}else{for(let i=start;i<symbols.length;i+=8){await Promise.all(symbols.slice(i,i+8).map(async s=>{try{await backfill(s)}catch(e){console.error(`skip ${s}: ${String(e)}`)}}));console.log(`${Math.min(i+8,symbols.length)}/${symbols.length}`);}}
