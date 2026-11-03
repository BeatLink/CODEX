export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type TaskSpec = {
  prompt: string;
  deliverable: string;
  depends_on?: number[];
};

export type TaskSnapshot = {
  id: string;
  parent: string | null;
  prompt: string;
  deliverable: string;
  depends_on: string[];
  status: TaskStatus;
  approach: string;
  result: string;
  note: string;
  replans: number;
  from_split: boolean;
};

export class TaskNode {
  id: string;
  prompt: string;
  deliverable: string;
  parent: TaskNode | null = null;
  dependsOn: string[] = [];
  children: TaskNode[] = [];
  status: TaskStatus = 'pending';
  approach = '';
  result = '';
  note = '';
  replans = 0;
  fromSplit = false;

  constructor(id: string, prompt: string, deliverable: string, parent: TaskNode | null = null, dependsOn: string[] = []) {
    this.id = id;
    this.prompt = prompt;
    this.deliverable = deliverable;
    this.parent = parent;
    this.dependsOn = [...dependsOn];
  }

  get depth(): number {
    return this.id.split('.').length - 1;
  }

  ancestors(): TaskNode[] {
    const chain: TaskNode[] = [];
    let current = this.parent;
    while (current) {
      chain.push(current);
      current = current.parent;
    }
    return chain.reverse();
  }

  snapshot(): Omit<TaskSnapshot, 'result' | 'replans' | 'from_split'> & {
    result: string;
    result_shortened: boolean;
  } {
    return {
      id: this.id,
      parent: this.parent?.id ?? null,
      prompt: this.prompt,
      deliverable: this.deliverable,
      depends_on: [...this.dependsOn],
      status: this.status,
      approach: this.approach,
      result: this.result.slice(0, 256),
      result_shortened: this.result.length > 256,
      note: this.note,
    };
  }

  state(): TaskSnapshot {
    return {
      ...this.snapshot(),
      result: this.result,
      replans: this.replans,
      from_split: this.fromSplit,
    } as TaskSnapshot;
  }
}

export class TaskTree {
  root: TaskNode;
  maxDepth: number;
  maxNodes: number;

  constructor(prompt: string, maxDepth: number, maxNodes: number) {
    this.root = new TaskNode('1', prompt, 'Provide the requested answer');
    this.maxDepth = maxDepth;
    this.maxNodes = maxNodes;
  }

  nodes(): TaskNode[] {
    const ordered: TaskNode[] = [];
    const stack: TaskNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      ordered.push(node);
      for (const child of [...node.children].reverse()) {
        stack.push(child);
      }
    }
    return ordered;
  }

  roomFor(node: TaskNode): number {
    if (node.depth >= this.maxDepth) {
      return 0;
    }

    const pending = node.children.filter((child) => child.status === 'pending').length;
    return this.maxNodes - this.nodes().length + pending;
  }

  setChildren(node: TaskNode, specs: TaskSpec[], fromSplit = false): TaskNode[] {
    const kept = node.children.filter((child) => child.status !== 'pending');
    const available = Math.max(0, Math.min(specs.length, this.roomFor(node)));
    const validSpecs = specs.slice(0, available);
    const added: TaskNode[] = [];

    for (let offset = 0; offset < validSpecs.length; offset += 1) {
      const spec = validSpecs[offset];
      const dependsOn = (spec.depends_on ?? [])
        .filter((index) => Number.isInteger(index) && index >= 1)
        .map((index) => `${node.id}.${index}`)
        .filter((id) => id !== `${node.id}.0`);
      const child = new TaskNode(
        `${node.id}.${kept.length + offset + 1}`,
        spec.prompt,
        spec.deliverable,
        node,
        dependsOn,
      );
      child.fromSplit = fromSplit;
      added.push(child);
    }

    node.children = [...kept, ...added];
    return added;
  }

  static fromState(prompt: string, nodes: Array<Record<string, any>>, maxDepth: number, maxNodes: number): TaskTree {
    const tree = new TaskTree(prompt, maxDepth, maxNodes);
    const built = new Map<string, TaskNode>();

    for (const saved of nodes) {
      const parentId = saved.parent ?? null;
      const parent = parentId ? built.get(parentId) ?? null : null;
      const node = parent ? new TaskNode(saved.id, saved.prompt, saved.deliverable, parent) : tree.root;
      node.dependsOn = Array.isArray(saved.depends_on) ? saved.depends_on.map(String) : [];
      node.status = (saved.status ?? 'pending') as TaskStatus;
      node.approach = String(saved.approach ?? '');
      node.result = String(saved.result ?? '');
      node.note = String(saved.note ?? '');
      node.replans = Number(saved.replans ?? 0);
      node.fromSplit = Boolean(saved.from_split);

      if (parent) {
        parent.children.push(node);
      }

      built.set(node.id, node);
    }

    for (const node of tree.nodes()) {
      if (!['done', 'failed', 'cancelled'].includes(node.status)) {
        node.status = 'pending';
        if (node.children.length === 0) {
          node.approach = '';
        }
      }
    }

    return tree;
  }

  snapshot(): Array<Omit<TaskSnapshot, 'result' | 'replans' | 'from_split'> & { result: string; result_shortened: boolean; }> {
    return this.nodes().map((node) => node.snapshot());
  }

  outline(current?: TaskNode): string {
    return this.nodes().map((node) => {
      const marker = node === current ? '  <- current task' : '';
      const approach = node.approach ? `, ${node.approach}` : '';
      return `${'  '.repeat(node.depth)}- ${node.id} [${node.status}${approach}] ${node.prompt}${marker}`;
    }).join('\n');
  }
}
