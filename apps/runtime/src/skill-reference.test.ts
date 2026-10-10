import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSkillReference } from './skill-reference.js';
test('model Skill references resolve to one active canonical registry address',()=>{
 const skills=[{address:'canonical-A',id:'research',active:true},{address:'canonical-B',id:'weather',active:true},{address:'canonical-C',id:'disabled',active:false}];
 assert.equal(resolveSkillReference('canonical-A',skills).address,'canonical-A');assert.equal(resolveSkillReference('research',skills).address,'canonical-A');
 for(const value of ['Research','research extra','disabled','canonical-C','fabricated'])assert.throws(()=>resolveSkillReference(value,skills),/unknown or ambiguous/);
 assert.throws(()=>resolveSkillReference('research',[...skills,{address:'other',id:'research',active:true}]),/ambiguous/);
});
