import knowledge from '../../../data/knowledge.json';

type Image = { imageId: string; src: string; alt: string; after?: string };
type Source = { title: string; url: string; text: string; images?: Image[] };
type Message = { role: 'user' | 'assistant'; content: string };
const docs: Source[] = knowledge as Source[];
function score(query:string,source:Source){return [...new Set(query.replace(/[？?，。！!、\s]/g,'').split(''))].reduce((sum,char)=>sum+((source.title+source.text).includes(char)?1:0),0)}
async function generate(question:string,sources:Source[]){
  const key=process.env.OPENROUTER_API_KEY;
  if(!key)return null;
  const context=sources.map((s,i)=>`[${i+1}] ${s.title}\n原文：${s.text}\n可用图片：${(s.images||[]).map(img=>`${img.imageId}（${img.alt}，建议放在“${img.after||'相关步骤'}”之后）`).join('；')||'无'}`).join('\n\n');
  const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','HTTP-Referer':'https://ihive-help-assistant-rebuilt.chatgpt.site','X-Title':'iHive Help Assistant'},body:JSON.stringify({model:process.env.OPENROUTER_MODEL||'openai/gpt-5-mini',messages:[{role:'system',content:'你是 iHive 帮助助手。只能依据给定飞书帮助文档用简洁中文回答，不得使用 PRD 或分工表作为答案依据。若资料不足要明确说明。可用图片与答案步骤相关时，在最合适的段落后单独插入 [[IMAGE:图片ID]]；没有相关图片就不要插入标记。不得把所有图片堆在答案末尾。'},{role:'user',content:`资料：\n${context}\n\n用户问题：${question}`}],temperature:0.2})});
  if(!response.ok)throw new Error('OpenRouter 服务暂时不可用');
  const result=await response.json() as {choices?:Array<{message?:{content?:string}}>};
  return result.choices?.[0]?.message?.content||null;
}
export async function POST(request:Request){try{const body=await request.json() as {messages?:Message[]};const question=body.messages?.at(-1)?.content?.trim();if(!question)return Response.json({error:'请输入问题'},{status:400});const sources=docs.map(source=>({...source,rank:score(question,source)})).sort((a,b)=>b.rank-a.rank).slice(0,3);const images=sources.flatMap(source=>source.images||[]);const answer=await generate(question,sources)||sources[0].text;return Response.json({answer,sources:sources.map(({title,url})=>({title,url})),images})}catch(error){return Response.json({error:error instanceof Error?error.message:'服务暂时不可用'},{status:500})}}
