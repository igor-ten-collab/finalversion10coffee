import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {startYooKassaPaymentScheduler} from './yookassa-payment-scheduler.mjs'
import {runYooKassaPaymentProcess} from './yookassa-payment-process.mjs'

function fixture(env={},runSync) {
  const timers=[],calls=[],messages=[],cleared=[]
  const stop=startYooKassaPaymentScheduler({env,
    setTimer:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer},clearTimer:x=>cleared.push(x),
    runSync:async options=>{calls.push(options);return runSync?runSync(options):{ok:true,exitCode:0}},
    logger:{log:s=>messages.push(s),error:(...a)=>messages.push(a.join(' '))}})
  return{stop,timers,calls,messages,cleared}
}

test('payment checks start without CRON_SECRET or env YOOKASSA_ENABLED because effective settings live in Payload',async()=>{
  const f=fixture()
  assert.equal(f.timers[0].ms,15000)
  await f.timers[0].fn()
  assert.equal(f.calls.length,1)
  assert.equal(f.timers[1].ms,60000)
  assert.match(f.messages.at(-1),/reconciliation completed/)
  f.stop()
})

test('payment reconciliation is not disabled by a false env override when Payload may enable it',()=>{
  const f=fixture({YOOKASSA_ENABLED:'false'})
  assert.equal(f.timers.length,1)
  f.stop()
  const disabled=fixture({YOOKASSA_PAYMENT_RECONCILIATION_ENABLED:'false'})
  assert.equal(disabled.timers.length,0)
  assert.match(disabled.messages[0],/disabled/)
})

test('no second timer is created while a payment worker is active',async()=>{
  let done
  const f=fixture({},()=>new Promise(resolve=>{done=resolve}))
  const running=f.timers[0].fn()
  assert.equal(f.timers.length,1)
  done({ok:true,exitCode:0})
  await running
  assert.equal(f.timers.length,2)
  f.stop()
})

test('worker failures retry next minute and shutdown aborts an in-flight worker',async()=>{
  const f=fixture({},async()=>{throw Error('worker unavailable')})
  await f.timers[0].fn()
  assert.equal(f.timers[1].ms,60000)
  f.stop()
  const g=fixture({},({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')))))
  const running=g.timers[0].fn()
  g.stop();await running
  assert.equal(g.calls[0].signal.aborted,true)
  assert.equal(g.timers.length,1)
})

test('real payment worker launcher uses the scoped TS entrypoint and real exit status',async()=>{
  for(const exitCode of [0,1]){
    const result=await runYooKassaPaymentProcess({spawnImpl:(binary,args,options)=>{
      assert.deepEqual(args,['--require','./scripts/os-userinfo-workaround.cjs','--import','tsx','scripts/reconcile-yookassa-payments.ts'])
      assert.equal(options.windowsHide,true)
      return spawn(binary,['-e',`process.exit(${exitCode})`],options)
    }})
    assert.equal(result.ok,exitCode===0)
    assert.equal(result.exitCode,exitCode)
  }
})

test('aborting the reconciliation launcher terminates its real child process',async()=>{
  const controller=new AbortController()
  let child
  const result=runYooKassaPaymentProcess({signal:controller.signal,spawnImpl:(binary,args,options)=>{
    child=spawn(binary,['-e','setInterval(()=>{},1000)'],options);return child
  }})
  const closed=new Promise(resolve=>child.once('close',resolve))
  controller.abort()
  await assert.rejects(result,{name:'AbortError'})
  await closed
  assert.equal(child.killed,true)
})
