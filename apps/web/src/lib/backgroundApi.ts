export function backgroundApiUrl(path:string,origin:string=''){
 if(!/^(scope|jobs|notifications|events\?after=(0|[1-9][0-9]{0,15})|jobs\/[a-f0-9-]{36}(\/(resume|cancel))?)$/.test(path))throw new Error('Invalid background service route.');
 if(!origin)return '/api/autonomous/'+path;
 const url=new URL(origin);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Background service must use a configured HTTPS origin.');
 return url.origin+'/api/autonomous/'+path;
}
