/*
 * Apsamo theme for SOGo webmail (Angular Material palettes).
 * Installed to /opt/mailcow/data/conf/sogo/custom-theme.js by
 * deploy/scripts/apply-mail-theme.sh. Mailcow keeps this file across updates
 * (it is in Mailcow's .gitignore). After a change:
 *   docker compose restart memcached-mailcow sogo-mailcow
 * Colours: Apsamo indigo #706FD3, deep #1E1A47, accent #8888FF.
 */
(function () {
  'use strict';

  angular.module('SOGo.Common')
    .config(configure);

  configure.$inject = ['$mdThemingProvider'];
  function configure($mdThemingProvider) {
    $mdThemingProvider.definePalette('apsamo-indigo', {
      '50': 'F0F0FB',
      '100': 'DCDCF5',
      '200': 'C3C3EE',
      '300': 'A9A8E6',
      '400': '8C8BDC',
      '500': '706FD3',
      '600': '5F5EC4',
      '700': '4F4EAE',
      '800': '3A3A85',
      '900': '1E1A47',
      'A100': 'D6D6FF',
      'A200': 'B0B0FF',
      'A400': '8888FF',
      'A700': '6C6CF5',
      'contrastDefaultColor': 'light',
      'contrastDarkColors': ['50', '100', '200', '300', 'A100', 'A200'],
      'contrastLightColors': undefined
    });

    $mdThemingProvider.definePalette('apsamo-surface', {
      '50': 'FFFFFF',
      '100': 'F5F7FC',
      '200': 'EEF0F8',
      '300': 'E6E9F2',
      '400': 'D6DAE8',
      '500': 'B8BED6',
      '600': '8B93B5',
      '700': '5C647A',
      '800': '2E3450',
      '900': '1B1F33',
      'A100': 'FFFFFF',
      'A200': 'F5F7FC',
      'A400': '5C647A',
      'A700': '1B1F33',
      '1000': '1B1F33',
      'contrastDefaultColor': 'dark',
      'contrastLightColors': ['700', '800', '900', 'A400', 'A700', '1000']
    });

    $mdThemingProvider.theme('default')
      .primaryPalette('apsamo-indigo', {
        'default': '500',
        'hue-1': '400',
        'hue-2': '900',
        'hue-3': 'A400'
      })
      .accentPalette('apsamo-indigo', {
        'default': 'A400',
        'hue-1': '300',
        'hue-2': '700',
        'hue-3': 'A700'
      })
      .warnPalette('red')
      .backgroundPalette('apsamo-surface');

    $mdThemingProvider.generateThemesOnDemand(false);
  }
})();
