(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./region-workbench-core') : root.V7RegionCore);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.V7RegionRuntime = api;
})(typeof window !== 'undefined' ? window : this, function(core) {
  'use strict';
  function create(deps) {
    let busy = false, stopped = false, taskId = '';
    const current = () => { if (!deps.isCurrent()) throw core.fail('账号已切换，旧区域操作已停止'); };
    const save = async run => { current(); await deps.save(run); current(); deps.changed(); };
    async function runJobs(run, selected) {
      if (busy) throw core.fail('区域任务正在运行');
      busy = true; stopped = false;
      try {
        for (const group of selected) {
          current(); if (stopped) break;
          for (const region of group) { region.status = 'running'; region.error = ''; }
          deps.changed();
          try {
            for (const region of group) {
              if (region.bound === false) throw core.fail('恢复记录须先重新绑定原文档');
              if (!region.inputAssetId) { const input = await deps.capture(region); current(); region.inputAssetId = input.id; }
            }
            if (stopped) { for (const region of group) region.status = 'interrupted'; await save(run); break; }
            const input = run.mode === 'stitch' ? await deps.sheet(group, run.layout) : await deps.asset(group[0].inputAssetId);
            current(); for (const region of group) region.attempts++;
            await save(run);
            const count = Math.max(1, run.options.batch - Math.min(...group.map(r => r.outputs.length)));
            const outputs = await deps.generate({ input, regions: group, run, count, setTaskId: value => { taskId = value; for (const region of group) region.lastTaskId = value; } }); current();
            if (!outputs || !outputs.length) throw core.fail('本次没有返回结果');
            // Result bytes are durable before the coordinate ledger references them.
            for (const output of outputs) {
              const parts = run.mode === 'stitch' ? await deps.split(output, run.layout) : [{ regionId: group[0].id, asset: await deps.put(output.full) }]; current();
              for (const part of parts) group.find(r => r.id === part.regionId).outputs.push({ assetId: part.asset.id, taskId, width: part.asset.width, height: part.asset.height, returned: false });
              for (const region of group) { region.status = region.outputs.length >= run.options.batch ? 'done' : 'partial'; if (region.status === 'partial') region.error = '仅返回部分结果，可重试缺少的张数'; }
              await save(run);
            }
          } catch (error) {
            current(); for (const region of group) { region.status = stopped ? 'interrupted' : 'failed'; region.error = String(error.message || error); }
            await save(run); deps.report(error);
          } finally { taskId = ''; }
        }
        return run;
      } catch (error) {
        for (const region of run.regions) if (region.status === 'running') { region.status = 'failed'; region.error = String(error.message || error); }
        throw error;
      } finally { busy = false; deps.changed(); }
    }
    async function cancel() { stopped = true; if (taskId && deps.cancel) await deps.cancel(taskId); }
    return { run: runJobs, cancel, busy: () => busy };
  }
  return { create };
});
