/**
 * computeAgentAwarePromptTemplateVersion (issue #28).
 *
 * A harness station running a named agent folds the agent name and the SHA-256
 * of its definition file into promptTemplateVersion, the binding-stamp input
 * that worker.uses skills already feed (computeSkillAwarePromptTemplateVersion).
 * No new stamp field: computeBindingStamp is unchanged, so every station
 * without an agent keeps its existing stamp.
 */
import { describe, it, expect } from 'bun:test';
import { computeAgentAwarePromptTemplateVersion } from './checkpoint';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('computeAgentAwarePromptTemplateVersion', () => {
  it('is deterministic', () => {
    expect(computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A)).toBe(
      computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A),
    );
  });

  it('moves when the definition hash moves', () => {
    expect(computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A)).not.toBe(
      computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_B),
    );
  });

  it('moves when only the agent name moves', () => {
    expect(computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A)).not.toBe(
      computeAgentAwarePromptTemplateVersion('1', 'team:reviewer', HASH_A),
    );
  });

  it('combines with the base version rather than replacing it', () => {
    expect(computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A)).not.toBe(
      computeAgentAwarePromptTemplateVersion('2', 'team:coder', HASH_A),
    );
  });

  it('never equals the bare base version, so an added agent always moves the stamp', () => {
    expect(computeAgentAwarePromptTemplateVersion('1', 'team:coder', HASH_A)).not.toBe('1');
  });
});
