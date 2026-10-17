const configuracao = require('./package.json').build;

module.exports = {
    ...configuracao,
    publish: [{
        provider: 'github',
        owner: 'guilhermefgfreitas',
        repo: 'gestor-facil',
        releaseType: 'release'
    }]
};
