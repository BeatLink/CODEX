import { describe, expect, it } from 'vitest';

import { TaskTree } from './taskTree.js';

describe('TaskTree', () => {
  it('creates root and child tasks with dependency numbering', () => {
    const tree = new TaskTree('Plan the release', 3, 8);
    const root = tree.root;

    const added = tree.setChildren(root, [
      { prompt: 'Draft the release notes', deliverable: 'Release notes summary', depends_on: [] },
      { prompt: 'Check the checklist', deliverable: 'Checklist status', depends_on: [1] },
    ]);

    expect(added.map((node) => node.id)).toEqual(['1.1', '1.2']);
    expect(added[1].dependsOn).toEqual(['1.1']);
    expect(tree.nodes().map((node) => node.id)).toEqual(['1', '1.1', '1.2']);
  });

  it('rebuilds an unfinished tree from saved state', () => {
    const tree = TaskTree.fromState(
      'Fix the bug',
      [
        {
          id: '1',
          parent: null,
          prompt: 'Fix the bug',
          deliverable: 'Fixed bug',
          depends_on: [],
          status: 'pending',
          approach: 'answer',
          result: '',
          note: '',
          replans: 0,
          from_split: false,
        },
        {
          id: '1.1',
          parent: '1',
          prompt: 'Investigate bug',
          deliverable: 'Root cause',
          depends_on: [],
          status: 'pending',
          approach: '',
          result: '',
          note: '',
          replans: 0,
          from_split: false,
        },
      ],
      4,
      8,
    );

    const root = tree.root;
    expect(root.children[0].id).toBe('1.1');
    expect(root.children[0].status).toBe('pending');
    expect(tree.snapshot()[0].id).toBe('1');
  });
});
