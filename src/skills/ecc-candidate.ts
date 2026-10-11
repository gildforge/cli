// Independently verified candidate/provenance only. Not a canonical wire object.
// Bundle serialization/identity and catalog authority await generated helpers.
import {
  readPinnedSkillFiles,
  type LocalSkillByteExpectation,
} from './local-bytes'
export const ECC_CANDIDATE = Object.freeze({
  repository: 'https://github.com/affaan-m/ECC',
  commit: 'd4a44ded8c150aac89b37c1f665b5a749fe52b02',
  bundlePath: 'pi/core/skills/verification-loop',
  originalLicensePath: 'pi/core/LICENSE',
  license: 'MIT',
})
export const ECC_CANDIDATE_BYTES: readonly LocalSkillByteExpectation[] =
  Object.freeze([
    Object.freeze({
      path: 'SKILL.md',
      size: 3064,
      sha256:
        '5b06be54d4852f60e6cf1b04c6e9a4748554334eb3e41af6c0959b544e6464ae',
    }),
    Object.freeze({
      path: 'LICENSE',
      size: 1071,
      sha256:
        '326146379f01bb137c0a5d3c54770c1aa31076705c8b88a7f6b26a460f6221b2',
    }),
  ])
export const readEccCandidate = (path: string) =>
  readPinnedSkillFiles(path, ECC_CANDIDATE_BYTES)
