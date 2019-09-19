import * as Fuse from "fuse.js";
import { SearchResultItem } from "../common/search-result-item";
import { SearchPlugin } from "./search-plugin";
import { UserConfigOptions } from "../common/config/user-config-options";
import { ExecutionPlugin } from "./execution-plugin";
import { UeliPlugin } from "./ueli-plugin";
import { TranslationSet } from "../common/translation/translation-set";
import { getNoSearchResultsFoundResultItem } from "./no-search-results-found-result-item";
import { FavoriteRepository } from "./favorites/favorite-repository";
import { FavoriteManager } from "./favorites/favorites-manager";
import { OpenLocationPlugin } from "./open-location-plugin";
import { AutoCompletionPlugin } from "./auto-completion-plugin";

interface FuseResult {
    item: SearchResultItem;
    score: number;
}

export class SearchEngine {
    private readonly searchPlugins: SearchPlugin[];
    private readonly executionPlugins: ExecutionPlugin[];
    private readonly fallbackPlugins: ExecutionPlugin[];
    private translationSet: TranslationSet;
    private config: UserConfigOptions;
    private readonly favoriteManager: FavoriteManager;

    constructor(
        plugins: SearchPlugin[],
        executionPlugins: ExecutionPlugin[],
        fallbackPlugins: ExecutionPlugin[],
        config: UserConfigOptions,
        translationSet: TranslationSet,
        favoriteRepository: FavoriteRepository) {
        this.translationSet = translationSet;
        this.config = config;
        this.searchPlugins = plugins;
        this.executionPlugins = executionPlugins;
        this.fallbackPlugins = fallbackPlugins;
        this.favoriteManager = new FavoriteManager(favoriteRepository, translationSet);
    }

    public  getSearchResults(userInput: string): Promise<SearchResultItem[]> {
        return new Promise((resolve, reject) => {
            if (userInput === undefined || userInput.length === 0) {
                resolve([]);
            } else {
                const matchingExecutionPlugin = this.executionPlugins
                    .filter((plugin) => plugin.isEnabled())
                    .find((plugin) => plugin.isValidUserInput(userInput));

                if (matchingExecutionPlugin !== undefined) {
                    matchingExecutionPlugin.getSearchResults(userInput)
                        .then((executionPluginResults) => {
                            this.beforeSolveSearchResults(userInput, executionPluginResults)
                                .then((result) => resolve(result))
                                .catch((err) => reject(err));
                        })
                        .catch((err) => reject(err));
                } else {
                    this.getSearchPluginsResult(userInput)
                        .then((searchPluginResults) => {
                            this.beforeSolveSearchResults(userInput, searchPluginResults)
                                .then((result) => resolve(result))
                                .catch((err) => reject(err));
                        })
                        .catch((err) => reject(err));
                }
            }
        });
    }

    public getFavorites(): Promise<SearchResultItem[]> {
        return new Promise((resolve) => {
            const result = this.favoriteManager.getAllFavorites()
                .sort((a, b) => b.executionCount - a.executionCount)
                .map((favorite) => favorite.item);

            resolve(result);
        });
    }

    public execute(searchResultItem: SearchResultItem, privileged: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            const originPlugin = this.getAllPlugins()
                .filter((plugin) => plugin.isEnabled())
                .find((plugin) => plugin.pluginType === searchResultItem.originPluginType);

            if (originPlugin !== undefined) {
                originPlugin.execute(searchResultItem, privileged)
                    .then(() => {
                        if (this.config.generalOptions.logExecution) {
                            this.favoriteManager.increaseCount(searchResultItem);
                        }
                        resolve();
                    })
                    .catch((err: string) => reject(err));
            } else {
                reject("Error while trying to execute search result item. No plugin found for this search result item");
            }
        });
    }

    public openLocation(searchResultItem: SearchResultItem): Promise<void> {
        return new Promise((resolve, reject) => {
            const originPlugin = this.getAllPlugins()
                .filter((plugin) => plugin.isEnabled())
                .find((plugin) => plugin.pluginType === searchResultItem.originPluginType);

            if (originPlugin && this.pluginSupportsOpenLocation(originPlugin)) {
                originPlugin.openLocation(searchResultItem)
                    .then(() => resolve())
                    .catch((err) => reject(err));
            } else {
                reject("Error while trying to open file location. No plugin found for the search result item");
            }
        });
    }

    public autoComplete(searchResultItem: SearchResultItem): string {
        const originPlugin = this.getAllPlugins()
            .filter((plugin) => plugin.isEnabled())
            .find((plugin) => plugin.pluginType === searchResultItem.originPluginType);

        if (originPlugin && this.pluginSupportsAutocompletion(originPlugin)) {
            return originPlugin.autoComplete(searchResultItem);
        } else {
            throw new Error("Error while trying to autocomplete. No plugin found for the search result item");
        }
    }

    public refreshIndexes(): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all(this.searchPlugins.filter((plugin) => plugin.isEnabled()).map((plugin) => plugin.refreshIndex()))
                .then(() => resolve())
                .catch((err) => reject(err));
        });
    }

    public clearCaches(): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all(this.searchPlugins.map((plugin) => plugin.clearCache()))
                .then(() => resolve())
                .catch((err) => reject(`Error while trying to clear cache: ${err}`));
        });
    }

    public updateConfig(updatedConfig: UserConfigOptions, translationSet: TranslationSet): Promise<void> {
        return new Promise((resolve, reject) => {
            this.translationSet = translationSet;
            this.favoriteManager.updateTranslationSet(translationSet);

            this.config = updatedConfig;

            Promise.all(this.getAllPlugins().map((plugin) => plugin.updateConfig(updatedConfig, translationSet)))
                .then(() => resolve())
                .catch((err) => reject(err));
        });
    }

    public clearExecutionLog(): Promise<void> {
        return this.favoriteManager.clearExecutionLog();
    }

    private getSearchPluginsResult(userInput: string): Promise<SearchResultItem[]> {
        return new Promise((resolve, reject) => {
            const pluginPromises = this.searchPlugins
                .filter((plugin) => plugin.isEnabled())
                .map((plugin) => plugin.getAll());

            Promise.all(pluginPromises)
                .then((pluginsResults) => {
                    const all = pluginsResults.length > 0
                        ? pluginsResults.reduce((a, r) => a = a.concat(r))
                        : [];

                    const fuse = new Fuse(all, {
                        distance: 100,
                        includeScore: true,
                        keys: ["searchable"],
                        location: 0,
                        maxPatternLength: 32,
                        minMatchCharLength: 1,
                        shouldSort: true,
                        threshold: this.config.searchEngineOptions.fuzzyness,
                    });

                    const fuseResult = fuse.search(userInput) as any[];

                    if (this.config.generalOptions.logExecution) {
                        fuseResult.forEach((fuseResultItem: FuseResult) => {
                            const favorite = this.favoriteManager.getAllFavorites()
                                .find((f) => f.item.executionArgument === fuseResultItem.item.executionArgument);
                            if (favorite && favorite.executionCount !== 0) {
                                fuseResultItem.score /= favorite.executionCount * 3;
                            }
                        });
                    }

                    const sorted = fuseResult.sort((a: FuseResult, b: FuseResult) => a.score  - b.score);
                    const filtered = sorted.map((item: FuseResult): SearchResultItem => item.item);
                    const sliced = filtered.slice(0, this.config.searchEngineOptions.maxSearchResults);

                    resolve(sliced);
                })
                .catch((pluginsError) => reject(pluginsError));
        });
    }

    private beforeSolveSearchResults(userInput: string, searchResults: SearchResultItem[]): Promise<SearchResultItem[]> {
        return new Promise((resolve, reject) => {
            if (this.fallbackPlugins.length > 0 && searchResults.length === 0) {
                const fallbackPluginPromises = this.fallbackPlugins
                    .filter((fallbackPlugin) => fallbackPlugin.isValidUserInput(userInput, true))
                    .map((fallbackPlugin) => fallbackPlugin.getSearchResults(userInput, true));

                Promise.all(fallbackPluginPromises)
                    .then((resultLists) => {
                        const result = resultLists.length > 0
                            ? resultLists.reduce((all, resultList) => all = all.concat(resultList))
                            : [];

                        resolve(this.beforeResolve(userInput, result));
                    })
                    .catch((err) => reject(err));
            } else {
                resolve(this.beforeResolve(userInput, searchResults));
            }
        });
    }

    private beforeResolve(userInput: string, searchResults: SearchResultItem[]): SearchResultItem[] {
        if (userInput.length > 0 && searchResults.length === 0) {
            const result = getNoSearchResultsFoundResultItem(
                this.translationSet.noSearchResultsFoundTitle,
                this.translationSet.noSearchResultsFoundDescription,
            );
            searchResults.push(result);
        }

        return(searchResults);
    }

    private getAllPlugins(): UeliPlugin[] {
        return [
            ...this.searchPlugins,
            ...this.executionPlugins,
        ];
    }

    private pluginSupportsOpenLocation(plugin: any): plugin is OpenLocationPlugin {
        const openLocationPlugin = plugin as OpenLocationPlugin;
        return openLocationPlugin.openLocation !== undefined;
    }

    private pluginSupportsAutocompletion(plugin: any): plugin is AutoCompletionPlugin {
        const autoCompletionPlugin = plugin as AutoCompletionPlugin;
        return autoCompletionPlugin.autoComplete !== undefined;
    }
}
