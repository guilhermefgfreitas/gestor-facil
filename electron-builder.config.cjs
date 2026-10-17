const configuracao = require('./package.json').build;

module.exports = {
    ...configuracao,
    artifactName: 'gestor-facil-setup-${version}.${ext}',
    publish: [{
        provider: 'github',
        owner: 'guilhermefgfreitas',
        repo: 'gestor-facil',
        releaseType: 'release'
    }]
};
