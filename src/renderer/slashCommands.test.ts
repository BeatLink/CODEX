import { describe, expect, it } from 'vitest';

import { commandSuggestions, completeCommand } from './slashCommands.js';

const userCommands = [{ name: 'review', description: 'Review a file', mode: 'answer' }, { name: 'release', description: '', mode: null }];

describe('slash command suggestions', () => {
    it('offers the memory commands, /init, mode words and user commands', () => {
        const names = commandSuggestions('/', userCommands).map((suggestion) => suggestion.name);

        expect(names).toEqual(['remember', 'memories', 'forget', 'init', 'answer', 'draft', 'plan', 'do', 'execute', 'review', 'release']);
    });

    it('narrows the list as the word is typed and stops once arguments start', () => {
        const matching = commandSuggestions('  /RE', userCommands);

        expect(matching.map((suggestion) => suggestion.name)).toEqual(['remember', 'review', 'release']);
        expect(matching[1].description).toBe('Review a file (answer mode)');
        expect(matching[2].description).toBe('Your command');
        expect(commandSuggestions('/remember tea', userCommands)).toEqual([]);
        expect(commandSuggestions('remember', userCommands)).toEqual([]);
    });

    it('puts the chosen command at the start and keeps the rest', () => {
        expect(completeCommand('/rem', 'remember')).toBe('/remember ');
        expect(completeCommand('  /x keep this', 'init')).toBe('/init keep this');
    });
});
