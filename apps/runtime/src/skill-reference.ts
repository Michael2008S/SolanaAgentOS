/** Canonicalize model references only within the supplied active registry.
 * Exact unique aliases are conveniences, never fuzzy tool discovery. */
export function resolveSkillReference<T extends {address:string;id:string;active:boolean}>(reference:string,skills:T[]):T {
 const exact=skills.filter(skill=>skill.address===reference);
 if(exact.length===1&&exact[0].active)return exact[0];
 if(exact.length)throw new Error('Model Skill reference is unknown or ambiguous.');
 const aliases=skills.filter(skill=>skill.active&&skill.id===reference);
 if(aliases.length!==1)throw new Error('Model Skill reference is unknown or ambiguous.');
 return aliases[0];
}
